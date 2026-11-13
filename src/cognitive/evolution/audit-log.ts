import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

export type AuditEntry = {
  id: string;
  timestamp: number;
  operation: string;
  actor: string;
  target: string;
  outcome: "success" | "failure" | "skipped";
  agentId?: string;
  metadata?: Record<string, unknown>;
};

/** Audit operations emitted by the skill approval workflow. */
export const EVOLUTION_AUDIT_OPERATIONS = {
  /** A draft was produced and is waiting for user approval. */
  draft: "skill.draft",
  /** The user approved a draft and it was written to disk. */
  approve: "skill.approve",
  /** The user rejected a draft; nothing was written. */
  reject: "skill.reject",
} as const;

export type EvolutionAuditOperation =
  (typeof EVOLUTION_AUDIT_OPERATIONS)[keyof typeof EVOLUTION_AUDIT_OPERATIONS];

export type EvolutionAuditEvent = {
  actor: string;
  target: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
};

const MAX_AUDIT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ARCHIVED_FILES = 5;

export class AuditLog {
  constructor(private readonly configDir: string) {}

  private filePath(): string {
    return join(this.configDir, "cognitive", "evolution", "audit.jsonl");
  }

  private dirPath(): string {
    return join(this.configDir, "cognitive", "evolution");
  }

  async append(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<AuditEntry> {
    const dir = this.dirPath();
    await mkdir(dir, { recursive: true });

    await this.rotateIfNeeded();

    const full: AuditEntry = {
      ...entry,
      id: randomUUID(),
      timestamp: Date.now(),
    };

    const line = JSON.stringify(full) + "\n";
    await appendFile(this.filePath(), line, "utf-8");
    return full;
  }

  /** Record that a skill draft is waiting for user approval. */
  async recordDraft(event: EvolutionAuditEvent): Promise<AuditEntry> {
    return this.append({
      operation: EVOLUTION_AUDIT_OPERATIONS.draft,
      actor: event.actor,
      target: event.target,
      outcome: "skipped",
      agentId: event.agentId,
      metadata: event.metadata,
    });
  }

  /** Record that a user approved a draft and it was persisted. */
  async recordApprove(event: EvolutionAuditEvent): Promise<AuditEntry> {
    return this.append({
      operation: EVOLUTION_AUDIT_OPERATIONS.approve,
      actor: event.actor,
      target: event.target,
      outcome: "success",
      agentId: event.agentId,
      metadata: event.metadata,
    });
  }

  /** Record that a user rejected a draft; nothing was written. */
  async recordReject(event: EvolutionAuditEvent): Promise<AuditEntry> {
    return this.append({
      operation: EVOLUTION_AUDIT_OPERATIONS.reject,
      actor: event.actor,
      target: event.target,
      outcome: "skipped",
      agentId: event.agentId,
      metadata: event.metadata,
    });
  }

  private async rotateIfNeeded(): Promise<void> {
    let size: number;
    try {
      const stats = await stat(this.filePath());
      size = stats.size;
    } catch {
      return;
    }
    if (size <= MAX_AUDIT_FILE_BYTES) {
      return;
    }
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    const archivePath = join(this.dirPath(), `audit-${stamp}.jsonl.rotated`);
    try {
      await rename(this.filePath(), archivePath);
    } catch {
      // best-effort rotation
      return;
    }
    await this.pruneOldArchives();
  }

  private async pruneOldArchives(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.dirPath());
    } catch {
      return;
    }
    const archives = entries
      .filter((name) => name.startsWith("audit-") && name.endsWith(".jsonl.rotated"))
      .toSorted((a, b) => a.localeCompare(b));
    while (archives.length > MAX_ARCHIVED_FILES) {
      const oldest = archives.shift();
      if (!oldest) {
        break;
      }
      try {
        await unlink(join(this.dirPath(), oldest));
      } catch {
        // best-effort
      }
    }
  }

  async query(filter: {
    actor?: string;
    operation?: string;
    since?: number;
  }): Promise<AuditEntry[]> {
    const path = this.filePath();
    if (!existsSync(path)) {
      return [];
    }

    try {
      const raw = await readFile(path, "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      const entries: AuditEntry[] = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as AuditEntry;
          if (filter.actor && entry.actor !== filter.actor) {
            continue;
          }
          if (filter.operation && entry.operation !== filter.operation) {
            continue;
          }
          if (filter.since && entry.timestamp < filter.since) {
            continue;
          }
          entries.push(entry);
        } catch {
          // Skip malformed lines
        }
      }

      return entries;
    } catch {
      return [];
    }
  }
}
