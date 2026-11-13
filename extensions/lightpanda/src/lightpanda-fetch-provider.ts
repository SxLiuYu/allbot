import { execFile } from "node:child_process";
import {
  markdownToText,
  truncateText,
  type WebFetchProviderPlugin,
  type WebFetchProviderToolDefinition,
} from "allbot/plugin-sdk/provider-web-fetch";
import { Type } from "typebox";

/**
 * Lightpanda-backed page fetching.
 *
 * Search results give snippets; the insight pipeline needs the page itself to
 * ground a claim. Lightpanda is a small headless browser that renders and
 * converts pages to markdown without a Chromium download, so this works on a
 * bare install the same way the Argo search provider does.
 *
 * Only `fetch` is used: Lightpanda's `search` subcommand needs a Brave/Tavily/
 * Exa key, which defeats the purpose. Search belongs to the Argo provider;
 * this one answers "given a URL, what does the page say".
 */

const DEFAULT_LIGHTPANDA_COMMAND = "lightpanda";
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_BYTES = 200_000;
const HARD_MAX_BYTES = 2_000_000;
const DEFAULT_WAIT_MS = 2_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

type LightpandaConfig = {
  command?: string;
  timeoutMs?: number;
  maxBytes?: number;
  waitMs?: number;
};

type LightpandaFetchOutput = {
  url?: unknown;
  http_status?: unknown;
  content?: unknown;
  error?: unknown;
};

function readConfig(fetchConfig?: Record<string, unknown>): LightpandaConfig {
  const scoped = fetchConfig?.lightpanda;
  return scoped && typeof scoped === "object" && !Array.isArray(scoped)
    ? (scoped as LightpandaConfig)
    : {};
}

function resolveNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/**
 * Lightpanda's `--json` emits one object per URL, or `{results: [...]}` for
 * several. `content` holds the dumped markdown.
 */
export function parseLightpandaOutput(stdout: string): LightpandaFetchOutput | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }
  // The dump can carry trailing log lines; take the outermost JSON object.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (Array.isArray(parsed)) {
    return parsed[0] as LightpandaFetchOutput | undefined;
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { results?: unknown }).results)
  ) {
    return ((parsed as { results: unknown[] }).results[0] ?? undefined) as
      | LightpandaFetchOutput
      | undefined;
  }
  return parsed as LightpandaFetchOutput;
}

function runLightpanda(params: {
  command: string;
  url: string;
  maxBytes: number;
  waitMs: number;
  timeoutMs: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      params.command,
      [
        "fetch",
        "--dump",
        "markdown",
        "--json",
        "--markdown-alternate",
        "--dump-max-bytes",
        String(params.maxBytes),
        "--wait-ms",
        String(params.waitMs),
        params.url,
      ],
      {
        timeout: params.timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          // Lightpanda writes the dump before exiting non-zero on HTTP errors;
          // keep usable content rather than failing the whole fetch.
          if (String(stdout ?? "").trim()) {
            resolve(String(stdout));
            return;
          }
          const detail = String(stderr ?? "").trim();
          reject(
            new Error(`Lightpanda fetch failed: ${detail || error.message}`, { cause: error }),
          );
          return;
        }
        resolve(String(stdout ?? ""));
      },
    );
  });
}

function createSchema() {
  return Type.Object(
    {
      url: Type.String({ description: "Absolute URL to fetch." }),
      maxChars: Type.Optional(
        Type.Number({
          description: "Cap on returned characters after markdown conversion.",
          minimum: 200,
          maximum: 500_000,
        }),
      ),
    },
    { additionalProperties: false },
  );
}

export function createToolDefinition(
  config: LightpandaConfig,
  fetchConfig?: Record<string, unknown>,
): WebFetchProviderToolDefinition {
  const merged = { ...readConfig(fetchConfig), ...config };
  return {
    description:
      "Fetch a web page and return its readable content as markdown. Renders the page, so client-side content is included.",
    parameters: createSchema() as unknown as Record<string, unknown>,
    execute: async (args: Record<string, unknown>) => {
      const rawUrl = typeof args.url === "string" ? args.url.trim() : "";
      if (!rawUrl) {
        return { error: "missing_url", message: "url is required." };
      }
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(rawUrl);
      } catch {
        return { error: "invalid_url", message: `Not an absolute URL: ${rawUrl}` };
      }
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        return {
          error: "unsupported_scheme",
          message: `Only http and https are supported, got ${parsedUrl.protocol}`,
        };
      }

      const maxBytes = resolveNumber(merged.maxBytes, DEFAULT_MAX_BYTES, 1000, HARD_MAX_BYTES);
      const waitMs = resolveNumber(merged.waitMs, DEFAULT_WAIT_MS, 0, 30_000);
      const timeoutMs = resolveNumber(merged.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 180_000);
      const maxChars = resolveNumber(args.maxChars, maxBytes, 200, 500_000);

      const stdout = await runLightpanda({
        command:
          typeof merged.command === "string" && merged.command.trim()
            ? merged.command.trim()
            : DEFAULT_LIGHTPANDA_COMMAND,
        url: parsedUrl.toString(),
        maxBytes,
        waitMs,
        timeoutMs,
      });

      const output = parseLightpandaOutput(stdout);
      if (!output) {
        return {
          error: "empty_response",
          message: "Lightpanda returned no parsable document.",
          url: parsedUrl.toString(),
        };
      }
      if (typeof output.error === "string" && output.error) {
        return {
          error: "fetch_failed",
          message: output.error,
          url: parsedUrl.toString(),
        };
      }

      const markdown = typeof output.content === "string" ? output.content : "";
      const httpStatus = typeof output.http_status === "number" ? output.http_status : undefined;
      if (!markdown.trim()) {
        // http_status 0 means navigation never completed (DNS, TLS, or a bot
        // challenge) — distinct from a 200 that simply renders nothing. The
        // caller needs that distinction to decide whether to retry or skip.
        const unreachable = httpStatus === 0;
        return {
          error: unreachable ? "navigation_failed" : "empty_content",
          message: unreachable
            ? "The page could not be loaded (navigation failed)."
            : "The page loaded but produced no readable content.",
          url: parsedUrl.toString(),
          status: httpStatus,
        };
      }

      const converted = markdownToText(markdown);
      const { text, truncated } = truncateText(converted, maxChars);
      return {
        url: typeof output.url === "string" ? output.url : parsedUrl.toString(),
        provider: "lightpanda",
        status: httpStatus,
        contentType: "text/markdown",
        externalContent: {
          untrusted: true,
          source: "web_fetch",
          provider: "lightpanda",
          wrapped: true,
        },
        text,
        truncated,
      };
    },
  };
}

export function createLightpandaWebFetchProvider(): WebFetchProviderPlugin {
  return {
    id: "lightpanda",
    label: "Lightpanda",
    hint: "Headless browser that renders pages to markdown; no API key required",
    requiresCredential: false,
    envVars: [],
    placeholder: "",
    signupUrl: "https://lightpanda.io/",
    docsUrl: "https://github.com/lightpanda-io/browser",
    autoDetectOrder: 1,
    credentialPath: "",
    getCredentialValue: () => undefined,
    setCredentialValue: () => {},
    createTool: (ctx) => createToolDefinition(readConfig(ctx.fetchConfig), ctx.fetchConfig),
  };
}

export const __testing = {
  parseLightpandaOutput,
  createToolDefinition,
} as const;
