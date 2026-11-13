import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AllBotConfig } from "../../config/config.js";
import { syncOwnerTaskFromCronRun } from "./cron-bridge.js";
import { createOwnerTaskStore } from "./store.js";
import { createOwnerTask, transitionOwnerTask } from "./transition.js";

const dirs: string[] = [];

function makeStore() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "owner-tasks-cron-"));
  dirs.push(dir);
  return createOwnerTaskStore({ filePath: path.join(dir, "owner-tasks.json") });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ENABLED = { tasks: { enabled: true, maxAttempts: 3 } } as AllBotConfig;
const DISABLED = {} as AllBotConfig;

function baseInput(store: ReturnType<typeof makeStore>, overrides: Record<string, unknown> = {}) {
  return {
    store,
    cfg: ENABLED,
    jobId: "job-1",
    jobName: "Morning check",
    sessionKey: "agent:main:main",
    status: "ok" as const,
    summary: "all good",
    now: 1_000,
    ...overrides,
  };
}

describe("syncOwnerTaskFromCronRun", () => {
  it("is a no-op when owner tasks are disabled or the run was skipped", async () => {
    const store = makeStore();
    const disabled = await syncOwnerTaskFromCronRun(baseInput(store, { cfg: DISABLED }));
    expect(disabled.synced).toBe(false);
    const skipped = await syncOwnerTaskFromCronRun(
      baseInput(store, { status: "skipped" as const }),
    );
    expect(skipped.synced).toBe(false);
    expect((await store.read()).tasks).toHaveLength(0);
  });

  it("stops at needs_review by default", async () => {
    const store = makeStore();
    const result = await syncOwnerTaskFromCronRun(baseInput(store));
    expect(result).toEqual({ synced: true, reviewRequired: true, taskId: expect.any(String) });
    const task = (await store.read()).tasks[0]!;
    expect(task.status).toBe("needs_review");
    expect(task.resultText).toBe("all good");
    expect(task.source).toMatchObject({ kind: "cron", autoAccept: false });
  });

  it("auto-accepts only when the job sets autoAccept", async () => {
    const store = makeStore();
    const result = await syncOwnerTaskFromCronRun(baseInput(store, { autoAccept: true }));
    expect(result.reviewRequired).toBe(false);
    expect((await store.read()).tasks[0]?.status).toBe("done");
  });

  it("does not auto-accept when autoAccept is not set", async () => {
    const store = makeStore();
    await syncOwnerTaskFromCronRun(baseInput(store, { autoAccept: false }));
    expect((await store.read()).tasks[0]?.status).toBe("needs_review");
  });

  it("updates one review card's result and version when the job reruns", async () => {
    const store = makeStore();
    await syncOwnerTaskFromCronRun(baseInput(store, { now: 1_000 }));
    const second = await syncOwnerTaskFromCronRun(
      baseInput(store, { summary: "run 2", now: 2_000 }),
    );
    expect(second.synced).toBe(true);
    expect(second.reviewRequired).toBe(false);
    const tasks = (await store.read()).tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("needs_review");
    expect(tasks[0]?.resultText).toBe("run 2");
    expect(tasks[0]?.resultVersion).toBe(2);
  });

  it("does not rewrite the store when a recurring run returns the same result", async () => {
    const store = makeStore();
    await syncOwnerTaskFromCronRun(baseInput(store, { now: 1_000 }));
    const before = (await store.read()).tasks[0]!;
    const second = await syncOwnerTaskFromCronRun(
      baseInput(store, { summary: "all good", now: 2_000 }),
    );
    expect(second.synced).toBe(true);
    const after = (await store.read()).tasks[0]!;
    expect(after.resultVersion).toBe(before.resultVersion);
    expect(after.revision).toBe(before.revision);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.events).toHaveLength(before.events.length);
  });

  it("does not create a new card when an auto-accepted job repeats its result", async () => {
    const store = makeStore();
    const first = await syncOwnerTaskFromCronRun(
      baseInput(store, { autoAccept: true, now: 1_000 }),
    );
    expect(first.reviewRequired).toBe(false);
    expect((await store.read()).tasks[0]?.status).toBe("done");
    const second = await syncOwnerTaskFromCronRun(
      baseInput(store, { autoAccept: true, summary: "all good", now: 2_000 }),
    );
    expect(second.taskId).toBe(first.taskId);
    const tasks = (await store.read()).tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("done");
    expect(tasks[0]?.resultVersion).toBe(1);
    expect(tasks[0]?.revision).toBe(3);
  });

  it("rejects a stale resultVersion after a cron result update", async () => {
    const store = makeStore();
    await syncOwnerTaskFromCronRun(baseInput(store, { now: 1_000 }));
    const taskId = (await store.read()).tasks[0]!.taskId;
    await syncOwnerTaskFromCronRun(baseInput(store, { summary: "run 2", now: 2_000 }));
    const stale = await transitionOwnerTask({
      store,
      taskId,
      to: "done",
      actor: "owner:ou_owner",
      expectedResultVersion: 1,
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) {
      return;
    }
    expect(stale.code).toBe("result_version_stale");
  });

  it("revives a failed cron task but not a failed user task", async () => {
    const store = makeStore();
    await syncOwnerTaskFromCronRun(baseInput(store, { status: "error" as const, now: 1_000 }));
    await syncOwnerTaskFromCronRun(baseInput(store, { now: 2_000 }));
    const cronTask = (await store.read()).tasks[0]!;
    expect(cronTask.status).toBe("needs_review");

    const userTask = await createOwnerTask({
      store,
      ownerId: "ou_owner",
      routerSessionKey: "agent:main:main",
      title: "user work",
      goal: "user work",
      source: { kind: "user" },
      worker: { kind: "subagent", runId: "user-run", childSessionKey: "child-user" },
    });
    await transitionOwnerTask({
      store,
      taskId: userTask.taskId,
      to: "failed",
      actor: "worker:subagent",
    });
    const revive = await transitionOwnerTask({
      store,
      taskId: userTask.taskId,
      to: "in_progress",
      actor: "worker:cron",
    });
    expect(revive.ok).toBe(false);
  });

  it("fails the task when the cron run failed", async () => {
    const store = makeStore();
    const result = await syncOwnerTaskFromCronRun(baseInput(store, { status: "error" as const }));
    expect(result.synced).toBe(true);
    const task = (await store.read()).tasks[0]!;
    expect(task.status).toBe("failed");
  });
});
