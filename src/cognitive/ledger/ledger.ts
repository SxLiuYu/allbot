import fs from "node:fs/promises";
import path from "node:path";
import { getOrCreateScopedAsyncLock } from "../../infra/json-files.js";

export type LedgerDecision = "sent" | "vetoed" | "failed";

export interface LedgerEntry {
  traceId: string;
  agentId: string;
  userId: string;
  at: number;
  eventType: string;
  decision: LedgerDecision;
  vetoReasons: string[];
  pNeed?: number;
  pAccept?: number;
  pAct?: number;
  threshold?: number;
  llmCalls: number;
  inputTokens?: number;
  outputTokens?: number;
  deliveryId?: string;
}

export interface DecisionLedger {
  record(entry: LedgerEntry): Promise<void>;
  listRecent(agentId: string, userId: string, limit: number): Promise<LedgerEntry[]>;
}

export interface DecisionLedgerOptions {
  dir: string;
  retentionDays?: number;
}

const DEFAULT_RETENTION_DAYS = 30;
const MS_PER_DAY = 86_400_000;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

const DECISION_VALUES: ReadonlySet<string> = new Set<LedgerDecision>(["sent", "vetoed", "failed"]);

function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  const { decision } = entry;
  return (
    typeof entry.traceId === "string" &&
    typeof entry.agentId === "string" &&
    typeof entry.userId === "string" &&
    typeof entry.at === "number" &&
    Number.isFinite(entry.at) &&
    typeof entry.eventType === "string" &&
    typeof decision === "string" &&
    DECISION_VALUES.has(decision) &&
    Array.isArray(entry.vetoReasons) &&
    entry.vetoReasons.every((reason) => typeof reason === "string") &&
    typeof entry.llmCalls === "number"
  );
}

/**
 * Append a single JSONL line. The JSONL format is append-only, so the
 * temp-file + rename strategy used by `writeTextAtomic` cannot be applied
 * without rewriting the whole file on every record. We instead keep the same
 * durability guarantees: recursive directory creation, 0600 file mode, and an
 * fsync before closing. A single O_APPEND write also keeps concurrent writers
 * from interleaving partial lines.
 */
async function appendLine(filePath: string, line: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: DIR_MODE });
  const handle = await fs.open(filePath, "a", FILE_MODE);
  try {
    await handle.writeFile(line, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
  try {
    await fs.chmod(filePath, FILE_MODE);
  } catch {
    // best-effort; ignore on platforms without chmod
  }
}

function resolveRetentionDays(retentionDays: number | undefined): number {
  if (typeof retentionDays !== "number" || !Number.isFinite(retentionDays) || retentionDays < 0) {
    return DEFAULT_RETENTION_DAYS;
  }
  return retentionDays;
}

export function createDecisionLedger(opts: DecisionLedgerOptions): DecisionLedger {
  const rootDir = path.resolve(opts.dir);
  const retentionMs = resolveRetentionDays(opts.retentionDays) * MS_PER_DAY;

  function entryPath(agentId: string, userId: string): string {
    return path.join(rootDir, agentId, `${userId}.jsonl`);
  }

  return {
    async record(entry: LedgerEntry): Promise<void> {
      const filePath = entryPath(entry.agentId, entry.userId);
      const line = `${JSON.stringify(entry)}\n`;
      // Scope the lock to the resolved file path so separate ledger instances
      // (and call sites) pointing at the same user file serialize their writes.
      const withLock = getOrCreateScopedAsyncLock(`decision-ledger:${filePath}`);
      await withLock(() => appendLine(filePath, line));
    },

    async listRecent(agentId: string, userId: string, limit: number): Promise<LedgerEntry[]> {
      const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
      if (max === 0) {
        return [];
      }
      const filePath = entryPath(agentId, userId);
      let raw: string;
      try {
        raw = await fs.readFile(filePath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw err;
      }

      const cutoff = Date.now() - retentionMs;
      const entries: LedgerEntry[] = [];
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (!isLedgerEntry(parsed) || parsed.at < cutoff) {
          continue;
        }
        entries.push(parsed);
      }

      // Newest first. Reversing before the stable sort makes entries written in
      // the same millisecond come back in reverse insertion order (latest first).
      entries.reverse();
      entries.sort((a, b) => b.at - a.at);
      return entries.slice(0, max);
    },
  };
}
