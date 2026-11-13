import path from "node:path";
import { acquireSessionWriteLock } from "../../agents/session-write-lock.js";
import type { AllBotConfig } from "../../config/config.js";
import { loadConfig } from "../../config/io.js";
import { resolveStateDir } from "../../config/paths.js";
import { readJsonFile, writeJsonAtomic } from "../../infra/json-files.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveOwnerTasksConfig } from "./config.js";
import type { OwnerTaskRecord, OwnerTaskStoreData } from "./types.js";

const log = createSubsystemLogger("owner-tasks");

export type ArchiveOwnerTasksResult = {
  archived: number;
  kept: number;
  archivePath: string;
};

export const DEFAULT_OWNER_TASK_ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_OWNER_TASK_ARCHIVE_MAX = 1000;

/**
 * Moves closed tasks older than `afterMs` out of the hot store into a
 * date-stamped archive file. Active tasks are never archived. The archive is
 * written before the hot store is rewritten, so a crash cannot lose records.
 */
export async function archiveOwnerTasks(params: {
  cfg?: AllBotConfig;
  statePath?: string;
  now?: number;
  afterMs?: number;
  maxArchive?: number;
}): Promise<ArchiveOwnerTasksResult> {
  const cfg = params.cfg ?? loadConfig();
  if (!resolveOwnerTasksConfig(cfg).enabled) {
    return { archived: 0, kept: 0, archivePath: "" };
  }
  const now = params.now ?? Date.now();
  const afterMs = params.afterMs ?? DEFAULT_OWNER_TASK_ARCHIVE_AFTER_MS;
  const maxArchive = params.maxArchive ?? DEFAULT_OWNER_TASK_ARCHIVE_MAX;
  const filePath =
    params.statePath ?? path.join(resolveStateDir(), "tasks", "owner-tasks.json");
  const archivePath = `${filePath}.archive-${new Date(now).toISOString().slice(0, 10)}.json`;

  const { release } = await acquireSessionWriteLock({
    sessionFile: filePath,
  });
  try {
    const current = (await readJsonFile<OwnerTaskStoreData>(filePath)) ?? {
      version: 1 as const,
      tasks: [],
    };
    const isClosed = (task: OwnerTaskRecord) =>
      task.status === "done" || task.status === "failed" || task.status === "cancelled";
    const stale = current.tasks
      .filter((task) => isClosed(task) && now - task.updatedAt >= afterMs)
      .slice(0, maxArchive);
    if (stale.length === 0) {
      return { archived: 0, kept: current.tasks.length, archivePath };
    }
    const staleIds = new Set(stale.map((task) => task.taskId));
    const previous =
      (await readJsonFile<{ version: 1; tasks: OwnerTaskRecord[] }>(archivePath))?.tasks ?? [];
    const merged = [...previous, ...stale].filter(
      (task, index, all) => all.findIndex((entry) => entry.taskId === task.taskId) === index,
    );
    await writeJsonAtomic(archivePath, { version: 1, tasks: merged });
    const kept = current.tasks.filter((task) => !staleIds.has(task.taskId));
    await writeJsonAtomic(filePath, { version: 1, tasks: kept });
    log.info("archived closed owner tasks", {
      archived: stale.length,
      kept: kept.length,
      archivePath,
    });
    return { archived: stale.length, kept: kept.length, archivePath };
  } finally {
    await release();
  }
}
