import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reconcileOwnerTasks } from "./reconcile.js";
import { createOwnerTaskStore } from "./store.js";
import { createOwnerTask, transitionOwnerTask } from "./transition.js";

const dirs: string[] = [];

function makeStore() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "owner-tasks-reconcile-"));
  dirs.push(dir);
  return createOwnerTaskStore({ filePath: path.join(dir, "owner-tasks.json") });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function input(store: ReturnType<typeof makeStore>) {
  return {
    store,
    ownerId: "ou_owner",
    routerSessionKey: "agent:main:main",
    title: "watch build",
    goal: "watch build",
    source: { kind: "user" as const },
    worker: { kind: "subagent" as const, runId: "run-1", childSessionKey: "child-1" },
  };
}

describe("reconcileOwnerTasks", () => {
  it("fails an old in_progress task whose worker is gone", async () => {
    const store = makeStore();
    const now = Date.now();
    const task = await createOwnerTask({ ...input(store), now: now - 60 * 60_000 });
    const result = await reconcileOwnerTasks({
      store,
      isWorkerAlive: () => false,
      staleMs: 30 * 60_000,
      now,
    });
    expect(result.orphanedTaskIds).toEqual([task.taskId]);
    const stored = (await store.read()).tasks[0]!;
    expect(stored.status).toBe("failed");
    expect(stored.error).toContain("Worker disappeared");
  });

  it("leaves live and recent tasks untouched", async () => {
    const store = makeStore();
    const now = Date.now();
    const oldAlive = await createOwnerTask({ ...input(store), now: now - 60 * 60_000 });
    const recentDead = await createOwnerTask({
      ...input(store),
      worker: { kind: "subagent", runId: "run-2", childSessionKey: "child-2" },
      now,
    });
    const result = await reconcileOwnerTasks({
      store,
      isWorkerAlive: (task) => task.taskId === oldAlive.taskId,
      staleMs: 30 * 60_000,
      now,
    });
    expect(result.orphanedTaskIds).toEqual([]);
    const byId = new Map((await store.read()).tasks.map((task) => [task.taskId, task]));
    expect(byId.get(oldAlive.taskId)?.status).toBe("in_progress");
    expect(byId.get(recentDead.taskId)?.status).toBe("in_progress");
  });

  it("never touches needs_review tasks", async () => {
    const store = makeStore();
    const now = Date.now();
    const task = await createOwnerTask({ ...input(store), now: now - 60 * 60_000 });
    await transitionOwnerTask({
      store,
      taskId: task.taskId,
      to: "needs_review",
      actor: "worker",
      resultText: "done",
      now: now - 60 * 60_000,
    });
    await reconcileOwnerTasks({ store, isWorkerAlive: () => false, staleMs: 1, now });
    expect((await store.read()).tasks[0]?.status).toBe("needs_review");
  });
});
