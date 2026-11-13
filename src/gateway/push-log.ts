import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveConfigDir } from "../utils.js";

/**
 * Append-only audit trail for every proactive push.
 *
 * The gateway log is a stream of human-readable lines and the decision ledger
 * records gate math. Neither answers "what did we actually send to this
 * person, and how many times". This file does: one JSONL line per push
 * attempt, including the ones that were refused, so a duplicate or a silent
 * failure can be reconstructed after the fact.
 *
 * Written with O_APPEND + fsync, 0600, under the config dir. A logging
 * failure never blocks delivery.
 */

export type PushOutcome = "sent" | "vetoed" | "failed" | "no_route" | "queued";

export interface PushLogEntry {
  at: number;
  iso: string;
  agentId: string;
  userId: string;
  kind: "first_contact" | "insight";
  outcome: PushOutcome;
  reason?: string;
  channel?: string;
  to?: string;
  sessionKey?: string;
  candidateId?: string;
  contentLength?: number;
  /** Set when the channel adapter returned a message id. */
  messageId?: string;
  /** Wall-clock time spent in the delivery attempt. */
  tookMs?: number;
  /** Number of web-search sources backing a generated insight (insight only). */
  sourceCount?: number;
  /** Milliseconds from insight generation to delivery confirmation (insight only). */
  deliveryLatencyMs?: number;
}

const PUSH_LOG_DIR = "proactive-push-log";
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export function resolvePushLogPath(now = Date.now()): string {
  const day = new Date(now).toISOString().slice(0, 10);
  return path.join(resolveConfigDir(), PUSH_LOG_DIR, `push-${day}.jsonl`);
}

export async function appendPushLog(entry: PushLogEntry): Promise<void> {
  const filePath = resolvePushLogPath(entry.at);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: DIR_MODE });
  const handle = await fs.open(filePath, "a", FILE_MODE);
  try {
    await handle.writeFile(`${JSON.stringify(entry)}\n`, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
  await fs.chmod(filePath, FILE_MODE).catch(() => undefined);
}

/** Fire-and-forget wrapper: audit logging must never break a push. */
export function recordPush(entry: PushLogEntry): void {
  void appendPushLog(entry).catch(() => undefined);
}

export async function readPushLog(
  day: string = new Date().toISOString().slice(0, 10),
): Promise<PushLogEntry[]> {
  const filePath = path.join(resolveConfigDir(), PUSH_LOG_DIR, `push-${day}.jsonl`);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as PushLogEntry];
      } catch {
        return [];
      }
    });
}

/**
 * True when a push-log already records a real delivery (`outcome:"sent"`,
 * `kind:"insight"`) for the given insight id. Used to make the
 * `recordInsightSentLog` write idempotent across the same UTC day and the day
 * before (the delivery confirmation can lag the enqueue across a midnight).
 */
export function hasInsightSentLogEntry(entries: PushLogEntry[], insightId: string): boolean {
  return entries.some(
    (e) => e.kind === "insight" && e.outcome === "sent" && e.candidateId === insightId,
  );
}

export type RecordInsightSentLogParams = {
  agentId: string;
  userId: string;
  insightId: string;
  sessionKey: string;
  contentLength: number;
  sourceCount?: number;
  messageId?: string;
  channel?: string;
  to?: string;
  generatedAt: number;
  at?: number;
};

/**
 * Record a real-delivery evidence line for a normal (non-first-contact)
 * insight. Idempotent per insight id across today and yesterday. Resolves to
 * `false` when nothing was written (already recorded, or the log write
 * failed) — callers must never let this throw into the delivery path.
 */
export async function recordInsightSentLog(params: RecordInsightSentLogParams): Promise<boolean> {
  try {
    const at = params.at ?? Date.now();
    const day = new Date(at).toISOString().slice(0, 10);
    const prevDay = new Date(at - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const recent = [...(await readPushLog(day)), ...(await readPushLog(prevDay))];
    if (hasInsightSentLogEntry(recent, params.insightId)) {
      return false;
    }
    await appendPushLog({
      at,
      iso: new Date(at).toISOString(),
      agentId: params.agentId,
      userId: params.userId,
      kind: "insight",
      outcome: "sent",
      candidateId: params.insightId,
      messageId: params.messageId,
      channel: params.channel,
      to: params.to,
      sessionKey: params.sessionKey,
      contentLength: params.contentLength,
      sourceCount: params.sourceCount,
      deliveryLatencyMs: at - params.generatedAt,
    });
    return true;
  } catch {
    return false;
  }
}
