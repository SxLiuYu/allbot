import { createHash } from "node:crypto";
import path from "node:path";
import type { AllBotConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { readJsonFile, writeJsonAtomic } from "../../infra/json-files.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("watch-loop");

export type WatchLoopSpec = {
  /** Stable id used for state and event dedupe. */
  id: string;
  /** Human-readable label shown in the wake message. */
  label: string;
  /** HTTPS URL to poll. Only GET is used. */
  url: string;
  /** Poll interval in milliseconds. Default: 15 minutes. */
  intervalMs?: number;
  /** Router session to wake when the observed content changes. */
  sessionKey: string;
  /** Optional instruction appended to the wake event. */
  instruction?: string;
};

export type WatchLoopPendingEvent = {
  id: string;
  sessionKey: string;
  contextKey: string;
  text: string;
  at: number;
};

export type WatchLoopState = {
  version: 1;
  hashes: Record<string, string>;
  lastCheckedAt: Record<string, number>;
  /** Survives restarts so a detected change is not lost before the Router drains it. */
  pendingEvents?: WatchLoopPendingEvent[];
};

export type WatchLoopDeps = {
  cfg: AllBotConfig;
  /** Fires a low-cost system event into the Router session. */
  enqueueSystemEvent: (text: string, opts: { sessionKey: string; contextKey: string }) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  statePath?: string;
};

export const DEFAULT_WATCH_LOOP_INTERVAL_MS = 15 * 60_000;

function resolveWatchSpecs(cfg: AllBotConfig): WatchLoopSpec[] {
  const raw = (cfg as { watchLoops?: unknown }).watchLoops;
  if (!Array.isArray(raw)) {
    return [];
  }
  const specs: WatchLoopSpec[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const item = entry as Partial<WatchLoopSpec>;
    if (
      typeof item.id !== "string" ||
      !item.id.trim() ||
      typeof item.url !== "string" ||
      !/^https:\/\//i.test(item.url)
    ) {
      continue;
    }
    specs.push({
      id: item.id.trim(),
      label: item.label?.trim() || item.id.trim(),
      url: item.url,
      intervalMs:
        typeof item.intervalMs === "number" && item.intervalMs >= 60_000
          ? Math.floor(item.intervalMs)
          : DEFAULT_WATCH_LOOP_INTERVAL_MS,
      sessionKey: item.sessionKey?.trim() || "agent:main:main",
      instruction: item.instruction?.trim() || undefined,
    });
  }
  return specs;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

async function readState(filePath: string): Promise<WatchLoopState> {
  const parsed = await readJsonFile<WatchLoopState>(filePath);
  if (
    parsed &&
    parsed.version === 1 &&
    parsed.hashes &&
    typeof parsed.hashes === "object" &&
    parsed.lastCheckedAt &&
    typeof parsed.lastCheckedAt === "object"
  ) {
    return parsed;
  }
  return { version: 1, hashes: {}, lastCheckedAt: {} };
}

export type WatchLoopTickResult = {
  checked: number;
  changed: string[];
  failed: string[];
};

/**
 * Polls configured URLs and only wakes the Router when content changes.
 * No model call happens on an unchanged tick, so a quiet hour costs no tokens.
 */
export async function runWatchLoopTick(deps: WatchLoopDeps): Promise<WatchLoopTickResult> {
  const specs = resolveWatchSpecs(deps.cfg);
  if (specs.length === 0) {
    return { checked: 0, changed: [], failed: [] };
  }
  const now = deps.now?.() ?? Date.now();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const filePath = deps.statePath ?? path.join(resolveStateDir(), "tasks", "watch-loop-state.json");
  const state = await readState(filePath);
  // Replay events persisted before a restart. enqueueSystemEvent dedupes
  // consecutive identical text per session, so replay is safe.
  const pending = state.pendingEvents ?? [];
  if (pending.length > 0) {
    for (const event of pending) {
      deps.enqueueSystemEvent(event.text, {
        sessionKey: event.sessionKey,
        contextKey: event.contextKey,
      });
    }
    state.pendingEvents = [];
    await writeJsonAtomic(filePath, state);
  }
  const due = specs.filter((spec) => {
    const last = state.lastCheckedAt[spec.id] ?? 0;
    return now - last >= (spec.intervalMs ?? DEFAULT_WATCH_LOOP_INTERVAL_MS);
  });
  if (due.length === 0) {
    return { checked: 0, changed: [], failed: [] };
  }

  const changed: string[] = [];
  const failed: string[] = [];
  let dirty = false;
  for (const spec of due) {
    try {
      const response = await fetchImpl(spec.url, {
        method: "GET",
        signal: AbortSignal.timeout(15_000),
        headers: { "user-agent": "allbot-watch-loop/1" },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const text = await response.text();
      const hash = hashText(text);
      const previous = state.hashes[spec.id];
      state.lastCheckedAt[spec.id] = now;
      dirty = true;
      if (previous === undefined) {
        // First observation establishes the baseline; it is not a "change".
        state.hashes[spec.id] = hash;
        continue;
      }
      if (previous === hash) {
        continue;
      }
      state.hashes[spec.id] = hash;
      changed.push(spec.id);
      const lines = [
        `[WatchLoop] ${spec.label} changed.`,
        `URL: ${spec.url}`,
        `Detected at: ${new Date(now).toISOString()}`,
      ];
      if (spec.instruction) {
        lines.push(`Instruction: ${spec.instruction}`);
      }
      const event: WatchLoopPendingEvent = {
        id: `${spec.id}:${now}`,
        sessionKey: spec.sessionKey,
        contextKey: `watch-loop:${spec.id}`,
        text: lines.join("\n"),
        at: now,
      };
      // Persist before enqueueing: a crash between detection and delivery must
      // not lose the change. The next tick replays anything still pending.
      state.pendingEvents = [...(state.pendingEvents ?? []), event].slice(-20);
      deps.enqueueSystemEvent(event.text, {
        sessionKey: event.sessionKey,
        contextKey: event.contextKey,
      });
    } catch (error) {
      failed.push(spec.id);
      log.warn("watch loop poll failed", {
        id: spec.id,
        url: spec.url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (dirty) {
    await writeJsonAtomic(filePath, state);
  }
  return { checked: due.length, changed, failed };
}
