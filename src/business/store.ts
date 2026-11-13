import fs from "node:fs/promises";
import path from "node:path";
import { acquireSessionWriteLock } from "../agents/session-write-lock.js";
import { resolveStateDir } from "../config/paths.js";
import {
  getOrCreateScopedAsyncLock,
  readJsonFile,
  writeJsonAtomic,
} from "../infra/json-files.js";
import {
  BUSINESS_REQUEST_STORE_VERSION,
  type BusinessRequestRecord,
  type BusinessRequestStoreData,
} from "./types.js";

export type BusinessRequestStore = {
  filePath: string;
  read: () => Promise<BusinessRequestStoreData>;
  update: <T>(
    mutator: (data: BusinessRequestStoreData) => { data: BusinessRequestStoreData | null; result: T },
  ) => Promise<T>;
};

/** `<stateDir>/business/requests.json` — separate from OwnerTask and session stores. */
export function resolveBusinessRequestStorePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveStateDir(env), "business", "requests.json");
}

function emptyStore(): BusinessRequestStoreData {
  return { version: BUSINESS_REQUEST_STORE_VERSION, requests: [] };
}

function isRecord(value: unknown): value is BusinessRequestRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const rec = value as Partial<BusinessRequestRecord>;
  return (
    typeof rec.requestId === "string" &&
    rec.requestId.trim() !== "" &&
    typeof rec.ownerId === "string" &&
    typeof rec.status === "string" &&
    Array.isArray(rec.events)
  );
}

function parseStoreData(value: unknown): BusinessRequestStoreData | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const rec = value as Partial<BusinessRequestStoreData>;
  if (rec.version !== BUSINESS_REQUEST_STORE_VERSION || !Array.isArray(rec.requests)) {
    return null;
  }
  return {
    version: BUSINESS_REQUEST_STORE_VERSION,
    requests: rec.requests.filter(isRecord),
  };
}

async function readStoreData(filePath: string): Promise<BusinessRequestStoreData> {
  return (await parseStoreData(await readJsonFile<unknown>(filePath))) ?? emptyStore();
}

async function backupIfPresent(filePath: string): Promise<void> {
  try {
    await fs.copyFile(filePath, `${filePath}.bak`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw err;
    }
  }
}

async function withBusinessRequestWriteLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const { release } = await acquireSessionWriteLock({ sessionFile: filePath });
  try {
    return await fn();
  } finally {
    await release();
  }
}

export function createBusinessRequestStore(
  options: { filePath?: string } = {},
): BusinessRequestStore {
  const filePath = options.filePath ?? resolveBusinessRequestStorePath();
  const withInProcessLock = getOrCreateScopedAsyncLock(`business-requests:${filePath}`);
  return {
    filePath,
    read: async () => await withInProcessLock(async () => await readStoreData(filePath)),
    update: async <T>(
      mutator: (data: BusinessRequestStoreData) => {
        data: BusinessRequestStoreData | null;
        result: T;
      },
    ): Promise<T> =>
      await withInProcessLock(async () =>
        await withBusinessRequestWriteLock(filePath, async () => {
          const outcome = mutator(await readStoreData(filePath));
          if (outcome.data) {
            await backupIfPresent(filePath);
            await writeJsonAtomic(filePath, outcome.data);
          }
          return outcome.result;
        }),
      ),
  };
}
