import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AllBotConfig } from "../../config/config.js";
import { archiveOwnerTasks } from "./archive.js";
import type { OwnerTaskRecord, OwnerTaskStoreData } from "./types.js";

const dirs: string[] = [];
const NOW = 1_800_000_000_000;
const WEEK = 7 * 24 * 60 * 60 * 1000;
const ENABLED = { tasks: { enabled: true } } as AllBotConfig;

function makeDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "owner-task-archive-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function task(id: string, status: OwnerTaskRecord["status"], ageMs: number): OwnerTaskRecord {
  return {
    taskId: id,
    shortId: id,
    ownerId: "ou_owner",
    routerSessionKey: "agent:main:main",
    title: id,
    goal: id,
    source: { kind: "user" },
    worker: { kind: "subagent", runId: id, childSessionKey: `child-${id}` },
    status,
    resultText: null,
    resultVersion: 0,
    artifacts: [],
    attemptCount: 1,
    revision: 1,
    createdAt: NOW - ageMs,
    updatedAt: NOW - ageMs,
    events: [],
  };
}

async function seed(filePath: string, tasks: OwnerTaskRecord[]) {
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({ version: 1, tasks }), "utf8");
}

describe("archiveOwnerTasks", () => {
  it("does nothing when owner tasks are disabled", async () => {
    const dir = makeDir();
    const filePath = path.join(dir, "owner-tasks.json");
    await seed(filePath, [task("old", "done", WEEK * 2)]);
    const result = await archiveOwnerTasks({
      cfg: {} as AllBotConfig,
      statePath: filePath,
      now: NOW,
    });
    expect(result.archived).toBe(0);
    const data = JSON.parse(await readFile(filePath, "utf8")) as OwnerTaskStoreData;
    expect(data.tasks).toHaveLength(1);
  });

  it("moves closed stale tasks into a dated archive and keeps active tasks", async () => {
    const dir = makeDir();
    const filePath = path.join(dir, "owner-tasks.json");
    await seed(filePath, [
      task("old-done", "done", WEEK * 2),
      task("old-failed", "failed", WEEK * 2),
      task("recent-done", "done", 1_000),
      task("active", "needs_review", WEEK * 3),
      task("running", "in_progress", WEEK * 3),
    ]);
    const result = await archiveOwnerTasks({
      cfg: ENABLED,
      statePath: filePath,
      now: NOW,
    });
    expect(result.archived).toBe(2);
    expect(result.kept).toBe(3);
    const data = JSON.parse(await readFile(filePath, "utf8")) as OwnerTaskStoreData;
    expect(data.tasks.map((entry) => entry.taskId).toSorted()).toEqual([
      "active",
      "recent-done",
      "running",
    ]);
    expect(existsSync(result.archivePath)).toBe(true);
    const archive = JSON.parse(await readFile(result.archivePath, "utf8")) as OwnerTaskStoreData;
    expect(archive.tasks.map((entry) => entry.taskId).toSorted()).toEqual([
      "old-done",
      "old-failed",
    ]);
  });

  it("is idempotent and never duplicates archived task ids", async () => {
    const dir = makeDir();
    const filePath = path.join(dir, "owner-tasks.json");
    await seed(filePath, [task("old", "done", WEEK * 2)]);
    const first = await archiveOwnerTasks({ cfg: ENABLED, statePath: filePath, now: NOW });
    expect(first.archived).toBe(1);
    const second = await archiveOwnerTasks({ cfg: ENABLED, statePath: filePath, now: NOW });
    expect(second.archived).toBe(0);
    const archive = JSON.parse(await readFile(first.archivePath, "utf8")) as OwnerTaskStoreData;
    expect(archive.tasks).toHaveLength(1);
  });
});
