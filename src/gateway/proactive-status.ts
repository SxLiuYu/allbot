import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { listBusinessProviderAdapters } from "../business/provider-registry.js";
import { createBusinessRequestStore } from "../business/store.js";
import { BUSINESS_REQUEST_STATUSES, type BusinessRequestStatus } from "../business/types.js";
import { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { readJsonFile } from "../infra/json-files.js";
import { resolveConfigDir } from "../utils.js";
import { isLocalDirectRequest } from "./auth.js";

const STATUS_PATH = "/__allbot/proactive-status";

type PushEntry = {
  outcome?: string;
  kind?: string;
  messageId?: string;
  reason?: string;
  at?: number;
};

function dayFile(day: string): string {
  return path.join(resolveConfigDir(), "proactive-push-log", `push-${day}.jsonl`);
}

function localDay(offsetDays = 0): string {
  const now = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

async function readPushLog(): Promise<{ entries: PushEntry[]; day: string }> {
  const today = localDay();
  try {
    const raw = await readFile(dayFile(today), "utf8");
    const entries = raw
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as PushEntry];
        } catch {
          return [];
        }
      });
    return { entries, day: today };
  } catch {
    return { entries: [], day: today };
  }
}

/** Read-only evidence of real inbound activity, taken from the gateway log. */
async function readFeishuInboundEvidence(): Promise<{
  bridgeHits: number;
  lastDmAt: string | null;
  lastDmText: string | null;
}> {
  try {
    const raw = await readFile(path.join(os.homedir(), "allbot-gateway.log"), "utf8");
    const lines = raw.split("\n");
    let bridgeHits = 0;
    let lastDmAt: string | null = null;
    let lastDmText: string | null = null;
    for (const line of lines) {
      if (line.includes("real feishu activity received")) {
        bridgeHits += 1;
      }
      const dm = /^(\S+).*Feishu\[default\] DM from [^:]+: (.*)$/.exec(line);
      if (dm) {
        lastDmAt = dm[1] ?? null;
        lastDmText = dm[2] ?? null;
      }
    }
    return { bridgeHits, lastDmAt, lastDmText };
  } catch {
    return { bridgeHits: 0, lastDmAt: null, lastDmText: null };
  }
}

/** Read the latest native GUI verdict written by the Aqua-session gate. */
async function readNativeDesktopGuiStatus(): Promise<
  "implemented" | "blocked_by_macos_permissions"
> {
  try {
    const raw = await readFile(path.join(os.homedir(), "gui-permission-verdict.txt"), "utf8");
    return raw.includes("gui_verdict=PASS") ? "implemented" : "blocked_by_macos_permissions";
  } catch {
    return "blocked_by_macos_permissions";
  }
}

/** Read-only aggregate of the always-on proactive layer. Loopback only. */
async function readBusinessRequestSummary(): Promise<{
  total: number;
  counts: Record<BusinessRequestStatus, number>;
  registeredProviders: number;
}> {
  const counts = Object.fromEntries(
    BUSINESS_REQUEST_STATUSES.map((status) => [status, 0]),
  ) as Record<BusinessRequestStatus, number>;
  try {
    const data = await createBusinessRequestStore().read();
    for (const request of data.requests) {
      if (counts[request.status] !== undefined) {
        counts[request.status] += 1;
      }
    }
    return {
      total: data.requests.length,
      counts,
      registeredProviders: listBusinessProviderAdapters().length,
    };
  } catch {
    return { total: 0, counts, registeredProviders: 0 };
  }
}

export function handleProactiveStatusHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const requestPath = new URL(req.url ?? "/", "http://localhost").pathname;
  if (requestPath !== STATUS_PATH) {
    return false;
  }
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.end("Method Not Allowed");
    return true;
  }
  if (!isLocalDirectRequest(req)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Forbidden: proactive status is loopback-only");
    return true;
  }

  void (async () => {
    try {
      const cfg = loadConfig();
      const { entries: pushLog, day: pushLogDay } = await readPushLog();
      const outcomes: Record<string, number> = {};
      let lastSent: PushEntry | undefined;
      let lastVetoReason: string | undefined;
      for (const entry of pushLog) {
        const outcome = entry.outcome ?? "unknown";
        outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
        if (outcome === "sent" && entry.messageId) {
          lastSent = entry;
        }
        if (outcome === "vetoed" && entry.reason) {
          lastVetoReason = entry.reason;
        }
      }
      const watchState = await readJsonFile<{
        hashes: Record<string, string>;
        lastCheckedAt: Record<string, number>;
        pendingEvents?: unknown[];
      }>(path.join(resolveStateDir(), "tasks", "watch-loop-state.json"));
      const feishuInbound = await readFeishuInboundEvidence();
      const nativeDesktopGui = await readNativeDesktopGuiStatus();
      const businessRequests = await readBusinessRequestSummary();
      const body = {
        cognitive: {
          enabled: cfg.cognitive?.enabled !== false,
          proactiveEnabled: cfg.cognitive?.proactive?.enabled === true,
          activeHours: cfg.cognitive?.proactive?.activeHours ?? null,
        },
        eventSources: {
          timer: "ProactiveScheduler.start()",
          infoScan: "installed",
          personaChange: "installed",
          evolutionScan: "installed",
          feishuActivity: "installed",
          external: "system-event (tag proactive:external)",
        },
        watchLoops: {
          configured: Array.isArray(cfg.watchLoops) ? cfg.watchLoops.length : 0,
          tracked: Object.keys(watchState?.hashes ?? {}).length,
          pendingEvents: watchState?.pendingEvents?.length ?? 0,
        },
        pushLog: {
          day: pushLogDay,
          total: pushLog.length,
          outcomes,
          lastSentMessageId: lastSent?.messageId ?? null,
          lastVetoReason: lastVetoReason ?? null,
        },
        feishuInbound,
        capabilities: {
          browserProxy: "implemented",
          systemRun: "implemented",
          nativeDesktopGui,
          paymentBusiness: "human_confirmation_workflow",
          identityBusiness: "human_confirmation_workflow",
          sensitiveTaskHumanReview: "implemented",
        },
        businessRequests,
      };
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(method === "HEAD" ? undefined : JSON.stringify(body, null, 2));
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(`proactive status unavailable: ${String(err)}`);
    }
  })();
  return true;
}
