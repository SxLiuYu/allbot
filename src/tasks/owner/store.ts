import fs from "node:fs/promises";
import path from "node:path";
import { acquireSessionWriteLock } from "../../agents/session-write-lock.js";
import { resolveStateDir } from "../../config/paths.js";
import {
  getOrCreateScopedAsyncLock,
  readJsonFile,
  writeJsonAtomic,
} from "../../infra/json-files.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  OWNER_TASK_STATUSES,
  OWNER_TASK_STORE_VERSION,
  type OwnerTaskRecord,
  type OwnerTaskStatus,
  type OwnerTaskStoreData,
} from "./types.js";

const log = createSubsystemLogger("owner-tasks");

const STATUS_SET = new Set<string>(OWNER_TASK_STATUSES);
const SHORT_ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const SHORT_ID_LENGTH = 6;

export type OwnerTaskStoreUpdate<T> = (data: OwnerTaskStoreData) => {
  data: OwnerTaskStoreData | null;
  result: T;
};

export type OwnerTaskStore = {
  filePath: string;
  read: () => Promise<OwnerTaskStoreData>;
  update: <T>(mutator: OwnerTaskStoreUpdate<T>) => Promise<T>;
};

/** `<stateDir>/tasks/owner-tasks.json` — separate from the run ledger SQLite file. */
export function resolveOwnerTaskStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "tasks", "owner-tasks.json");
}

function isStatus(value: unknown): value is OwnerTaskStatus {
  return typeof value === "string" && STATUS_SET.has(value);
}

function generateShortId(): string {
  const bytes = new Uint8Array(SHORT_ID_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => SHORT_ID_ALPHABET[byte % SHORT_ID_ALPHABET.length]).join("");
}

/** Allocates a human-typable short id that is unique in the current store. */
export function allocateOwnerTaskShortId(
  data: OwnerTaskStoreData,
  random: () => string = generateShortId,
): string {
  const used = new Set(data.tasks.map((task) => task.shortId).filter(Boolean));
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = random();
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  throw new Error("unable to allocate a unique owner task shortId");
}

function isRecord(value: unknown): value is OwnerTaskRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const rec = value as Partial<OwnerTaskRecord>;
  return (
    typeof rec.taskId === "string" &&
    rec.taskId.trim() !== "" &&
    typeof rec.ownerId === "string" &&
    typeof rec.routerSessionKey === "string" &&
    isStatus(rec.status)
  );
}

function parseStoreData(value: unknown): OwnerTaskStoreData | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const rec = value as Partial<OwnerTaskStoreData>;
  if (rec.version !== OWNER_TASK_STORE_VERSION || !Array.isArray(rec.tasks)) {
    return null;
  }
  return {
    version: OWNER_TASK_STORE_VERSION,
    tasks: rec.tasks.filter(isRecord),
  };
}

/**
 * Display fallback for records written before shortId existed. Full uuids are
 * never shown to users; the short id is lazily persisted on the next write.
 */
export function resolveOwnerTaskDisplayId(task: OwnerTaskRecord): string {
  return task.shortId ?? task.taskId.replace(/^task_/, "").slice(0, 8);
}

function withShortIds(data: OwnerTaskStoreData): OwnerTaskStoreData {
  const used = new Set<string>();
  let changed = false;
  const tasks = data.tasks.map((task) => {
    let shortId = task.shortId;
    if (!shortId || used.has(shortId)) {
      const taken = new Set([...used, ...data.tasks.map((entry) => entry.shortId).filter(Boolean)]);
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const candidate = generateShortId();
        if (!taken.has(candidate)) {
          shortId = candidate;
          break;
        }
      }
      shortId ??= resolveOwnerTaskDisplayId(task);
      changed = true;
    }
    used.add(shortId);
    return changed || shortId !== task.shortId ? { ...task, shortId } : task;
  });
  return changed ? { ...data, tasks } : data;
}

function emptyStore(): OwnerTaskStoreData {
  return { version: OWNER_TASK_STORE_VERSION, tasks: [] };
}

async function readStoreData(filePath: string): Promise<OwnerTaskStoreData> {
  const primary = parseStoreData(await readJsonFile<unknown>(filePath));
  if (primary) {
    return primary;
  }
  const rawPrimary = await readJsonFile<unknown>(filePath);
  if (rawPrimary !== null) {
    log.warn("owner task store is unreadable; trying backup", { filePath });
  }
  const backup = parseStoreData(await readJsonFile<unknown>(`${filePath}.bak`));
  return backup ?? emptyStore();
}

async function backupIfPresent(filePath: string): Promise<void> {
  try {
    await fs.copyFile(filePath, `${filePath}.bak`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return;
    }
    log.warn("owner task store backup failed", {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Serializes writers across processes. Reads rely on atomic writes. */
async function withOwnerTaskWriteLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const { release } = await acquireSessionWriteLock({ sessionFile: filePath });
  try {
    return await fn();
  } finally {
    await release();
  }
}

export function createOwnerTaskStore(options: { filePath?: string } = {}): OwnerTaskStore {
  const filePath = options.filePath ?? resolveOwnerTaskStorePath();
  const withInProcessLock = getOrCreateScopedAsyncLock(`owner-tasks:${filePath}`);

  return {
    filePath,
    read: async () =>
      await withInProcessLock(async () => {
        const current = await readStoreData(filePath);
        const migrated = withShortIds(current);
        if (migrated !== current) {
          await backupIfPresent(filePath);
          await writeJsonAtomic(filePath, migrated);
        }
        return migrated;
      }),
    update: async <T>(mutator: OwnerTaskStoreUpdate<T>): Promise<T> =>
      await withInProcessLock(
        async () =>
          await withOwnerTaskWriteLock(filePath, async () => {
            const current = withShortIds(await readStoreData(filePath));
            const outcome = mutator(current);
            if (outcome.data) {
              const next = withShortIds(outcome.data);
              await backupIfPresent(filePath);
              await writeJsonAtomic(filePath, next);
            }
            return outcome.result;
          }),
      ),
  };
}
