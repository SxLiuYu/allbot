import { execFile } from "node:child_process";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  mergeScopedSearchConfig,
  readCachedSearchPayload,
  readNumberParam,
  readStringParam,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSiteName,
  resolveSearchTimeoutSeconds,
  writeCachedSearchPayload,
  wrapWebContent,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
} from "allbot/plugin-sdk/provider-web-search";
import { Type } from "typebox";

/**
 * Argo-backed web search.
 *
 * Argo aggregates several hundred search sources and the free engines need no
 * API key, which is what makes this provider useful: AllBot's insight pipeline
 * refuses to deliver an insight without at least one source, so an install
 * with no paid search credential produces nothing at all. Argo closes that gap
 * without adding a billing dependency.
 *
 * Transport is the CLI's single-shot mode (`argo-search call <tool> <json>`),
 * not MCP: the insight pipeline needs a plain function that returns results,
 * and MCP would require an extra protocol client plus a long-lived child.
 */

const DEFAULT_ARGO_COMMAND = "argo-search";
const ARGO_SEARCH_TOOL = "argo_search";
const ARGO_MAX_COUNT = 20;
const ARGO_DEFAULT_TIMEOUT_MS = 45_000;
const ARGO_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

type ArgoConfig = {
  command?: string;
  timeoutMs?: number;
};

type ArgoResult = {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  description?: unknown;
  published_at?: unknown;
  source?: unknown;
};

function readArgoConfig(searchConfig?: SearchConfigRecord): ArgoConfig {
  const argo = searchConfig?.argo;
  return argo && typeof argo === "object" && !Array.isArray(argo) ? (argo as ArgoConfig) : {};
}

const ARGO_SORT_VALUES = ["relevance", "oldest", "newest"] as const;
const ARGO_DEPTH_VALUES = ["fast", "balanced", "deep"] as const;
type ArgoSort = (typeof ARGO_SORT_VALUES)[number];
type ArgoDepth = (typeof ARGO_DEPTH_VALUES)[number];

type ArgoSearchOptions = {
  since?: string;
  until?: string;
  sort?: string;
  engine?: string;
  depth?: string;
};

export function isArgoSort(value: unknown): value is ArgoSort {
  return typeof value === "string" && (ARGO_SORT_VALUES as readonly string[]).includes(value);
}

export function isArgoDepth(value: unknown): value is ArgoDepth {
  return typeof value === "string" && (ARGO_DEPTH_VALUES as readonly string[]).includes(value);
}

/**
 * Only forward fully-formed, valid filter values to the argo CLI. Empty
 * strings and invalid enum members are dropped so they never turn into a
 * malformed CLI argument (e.g. an empty `engine:""` or `sort:"foo"`).
 */
export function sanitizeArgoOptions(options?: ArgoSearchOptions): ArgoSearchOptions {
  if (!options || typeof options !== "object") {
    return {};
  }
  const result: ArgoSearchOptions = {};
  const since = typeof options.since === "string" ? options.since.trim() : "";
  const until = typeof options.until === "string" ? options.until.trim() : "";
  const engine = typeof options.engine === "string" ? options.engine.trim() : "";
  if (since) {
    result.since = since;
  }
  if (until) {
    result.until = until;
  }
  if (engine) {
    result.engine = engine;
  }
  if (isArgoSort(options.sort)) {
    result.sort = options.sort;
  }
  if (isArgoDepth(options.depth)) {
    result.depth = options.depth;
  }
  return result;
}

export function resolveCommand(config: ArgoConfig | undefined): string {
  const configured = typeof config?.command === "string" ? config.command.trim() : "";
  return configured || DEFAULT_ARGO_COMMAND;
}

function resolveTimeoutMs(config: ArgoConfig | undefined, searchConfig?: SearchConfigRecord): number {
  if (typeof config?.timeoutMs === "number" && Number.isFinite(config.timeoutMs)) {
    return Math.max(1000, Math.min(180_000, Math.floor(config.timeoutMs)));
  }
  return resolveSearchTimeoutSeconds(searchConfig) * 1000 || ARGO_DEFAULT_TIMEOUT_MS;
}

/**
 * Argo prints one MCP-style envelope: `{"content":[{"type":"text","text":"<json>"}]}`.
 * The payload we want is the JSON string inside `text`, so unwrap it and fall
 * back to parsing the raw stdout when the shape differs (older builds, errors).
 */
export function unwrapArgoPayload(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return undefined;
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return undefined;
  }

  const content = (envelope as { content?: unknown }).content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const entry = block as { type?: unknown; text?: unknown };
      if (entry.type === "text" && typeof entry.text === "string") {
        try {
          return JSON.parse(entry.text);
        } catch {
          return entry.text;
        }
      }
    }
  }

  return envelope;
}

export function normalizeArgoResults(payload: unknown): ArgoResult[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    return [];
  }
  return results.filter(
    (entry): entry is ArgoResult =>
      Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
  );
}

export function buildArgoArgs(
  query: string,
  count: number,
  options?: ArgoSearchOptions,
): Record<string, unknown> {
  const args: Record<string, unknown> = { query, count };
  for (const [key, value] of Object.entries(sanitizeArgoOptions(options))) {
    if (value !== undefined && value !== "") {
      args[key] = value;
    }
  }
  return args;
}

/**
 * Resolve how to launch Argo.
 *
 * A bare `argo-search` is a real executable (the CLI installs a shim), so it
 * spawns directly. A path to `bin/argo.js` is not executable on Windows and
 * fails with EFTYPE, so a `.js`/`.mjs`/`.cjs` target is run through the current
 * Node binary instead.
 */
function resolveLaunch(command: string): { file: string; prefixArgs: string[] } {
  if (/\.(?:[cm]?js)$/i.test(command)) {
    return { file: process.execPath, prefixArgs: [command] };
  }
  return { file: command, prefixArgs: [] };
}

function runArgoCli(params: {
  command: string;
  args: Record<string, unknown>;
  timeoutMs: number;
}): Promise<string> {
  const launch = resolveLaunch(params.command);
  return new Promise((resolve, reject) => {
    execFile(
      launch.file,
      [...launch.prefixArgs, "call", ARGO_SEARCH_TOOL, JSON.stringify(params.args)],
      {
        timeout: params.timeoutMs,
        maxBuffer: ARGO_MAX_OUTPUT_BYTES,
        windowsHide: true,
        // Argo's own UTF-8 mode; without it a non-ASCII query can corrupt
        // argument handling on Windows.
        env: { ...process.env, PYTHONUTF8: process.env.PYTHONUTF8 ?? "1" },
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr ?? "").trim() || String(stdout ?? "").trim();
          reject(
            new Error(
              `Argo search failed (${params.command}): ${detail || error.message}`,
              { cause: error },
            ),
          );
          return;
        }
        resolve(String(stdout ?? ""));
      },
    );
  });
}

function optionalStringEnum<T extends readonly string[]>(values: T, description: string) {
  return Type.Optional(
    Type.Unsafe<T[number]>({
      type: "string",
      enum: [...values],
      description,
    }),
  );
}

function createArgoSchema() {
  return Type.Object(
    {
      query: Type.String({ description: "Search query string." }),
      count: Type.Optional(
        Type.Number({
          description: `Number of results to return (1-${ARGO_MAX_COUNT}).`,
          minimum: 1,
          maximum: ARGO_MAX_COUNT,
        }),
      ),
      since: Type.Optional(
        Type.String({
          description:
            "Lower bound for result recency. Use an ISO date (YYYY-MM-DD, e.g. 2026-11-05) or a relative window like 7d. Pass with `until` to scope a time range; useful for fresh news retrieval.",
        }),
      ),
      until: Type.Optional(
        Type.String({
          description:
            "Upper bound for result recency. Use an ISO date (YYYY-MM-DD) or a relative window like 1d. Pass with `since` to scope a time range; useful for fresh news retrieval.",
        }),
      ),
      sort: optionalStringEnum(
        ARGO_SORT_VALUES,
        'Result ordering: "relevance" (default), "oldest", or "newest". Use "newest" with since/until for time-sensitive news.',
      ),
      engine: Type.Optional(
        Type.String({
          description:
            'Search engine selector passed to argo, e.g. "anysearch" for fresh general-web news, "people_daily", or leave blank to use argo\'s default. NOTE: "google_news" can error on Chinese queries; default behavior is preferred unless freshness is needed.',
        }),
      ),
      depth: optionalStringEnum(
        ARGO_DEPTH_VALUES,
        'Search depth: "fast" (default), "balanced" (slower, may fan out to multiple engines and risk timeout), or "deep".',
      ),
    },
    { additionalProperties: false },
  );
}

function createArgoToolDefinition(
  config: ArgoConfig | undefined,
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  return {
    description:
      "Search the web with Argo, which aggregates hundreds of sources and needs no API key. Returns titles, URLs and snippets.",
    parameters: createArgoSchema() as unknown as Record<string, unknown>,
    execute: async (args) => {
      const query = readStringParam(args, "query", { required: true }).trim();
      if (!query) {
        return {
          error: "empty_query",
          message: "query must not be empty.",
        };
      }

      const requested = readNumberParam(args, "count", { integer: true });
      const count = Math.max(1, Math.min(ARGO_MAX_COUNT, requested ?? DEFAULT_SEARCH_COUNT));
      const command = resolveCommand(config);

      const options: ArgoSearchOptions = {
        since: readStringParam(args, "since"),
        until: readStringParam(args, "until"),
        sort: readStringParam(args, "sort"),
        engine: readStringParam(args, "engine"),
        depth: readStringParam(args, "depth"),
      };

      const cacheKey = buildSearchCacheKey([
        "argo",
        query,
        count,
        options.since,
        options.until,
        options.sort,
        options.engine,
        options.depth,
      ]);
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const start = Date.now();
      const stdout = await runArgoCli({
        command,
        args: buildArgoArgs(query, count, options),
        timeoutMs: resolveTimeoutMs(config, searchConfig),
      });

      const payload = unwrapArgoPayload(stdout);
      const results = normalizeArgoResults(payload).slice(0, count);

      const response = {
        query,
        provider: "argo",
        count: results.length,
        tookMs: Date.now() - start,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: "argo",
          wrapped: true,
        },
        results: results.map((entry) => {
          const title = typeof entry.title === "string" ? entry.title : "";
          const url = typeof entry.url === "string" ? entry.url : "";
          const snippetRaw =
            typeof entry.snippet === "string"
              ? entry.snippet
              : typeof entry.description === "string"
                ? entry.description
                : "";
          const published =
            typeof entry.published_at === "string" && entry.published_at
              ? entry.published_at
              : undefined;
          return {
            title: title ? wrapWebContent(title, "web_search") : "",
            url,
            description: snippetRaw ? wrapWebContent(snippetRaw, "web_search") : "",
            ...(published ? { published } : {}),
            siteName: resolveSiteName(url) || undefined,
          };
        }),
      };

      writeCachedSearchPayload(cacheKey, response, resolveSearchCacheTtlMs(searchConfig));
      return response;
    },
  };
}

export function createArgoWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "argo",
    label: "Argo Search",
    hint: "Aggregates hundreds of sources; no API key required",
    onboardingScopes: ["text-inference"],
    requiresCredential: false,
    envVars: [],
    placeholder: "",
    signupUrl: "https://github.com/taxueseek/argo",
    docsUrl: "https://github.com/taxueseek/argo",
    // Preferred over credential-gated providers when nothing is configured:
    // the point of this provider is that it works on a bare install.
    autoDetectOrder: 1,
    credentialPath: "",
    getCredentialValue: () => undefined,
    setCredentialValue: () => {},
    createTool: (ctx) =>
      createArgoToolDefinition(
        readArgoConfig(
          mergeScopedSearchConfig(
            ctx.searchConfig,
            "argo",
            resolveProviderWebSearchPluginConfig(ctx.config, "argo"),
          ) as SearchConfigRecord | undefined,
        ),
        ctx.searchConfig as SearchConfigRecord | undefined,
      ),
  };
}

export const __testing = {
  unwrapArgoPayload,
  normalizeArgoResults,
  buildArgoArgs,
  sanitizeArgoOptions,
  isArgoSort,
  isArgoDepth,
  resolveCommand,
} as const;
