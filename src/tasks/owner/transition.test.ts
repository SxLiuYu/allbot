import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOwnerTaskStore, type OwnerTaskStore } from "./store.js";
import {
  AUTO_ACCEPT_ACTOR,
  OWNER_TASK_TRANSITIONS,
  createOwnerTask,
  findOwnerTaskByWorker,
  transitionOwnerTask,
} from "./transition.js";
import type { OwnerTaskStatus } from "./types.js";

const dirs: string[] = [];

function makeStore(): OwnerTaskStore {
  const dir = mkdtempSync(path.join(os.tmpdir(), "owner-tasks-"));
  dirs.push(dir);
  return createOwnerTaskStore({ filePath: path.join(dir, "owner-tasks.json") });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function newTaskInput(
  store: OwnerTaskStore,
  overrides: { status?: "pending" | "in_progress" } = {},
) {
  return {
    store,
    ownerId: "ou_owner",
    routerSessionKey: "agent:main:main",
    title: "Research pricing",
    goal: "Collect competitor pricing",
    source: { kind: "user" as const },
    worker: { kind: "subagent" as const, runId: "run-1", childSessionKey: "agent:main:subagent:1" },
    ...overrides,
  };
}

describe("owner task transitions", () => {
  it("declares the documented transition table", () => {
    expect(OWNER_TASK_TRANSITIONS).toEqual({
      pending: ["in_progress", "cancelled"],
      in_progress: ["needs_review", "failed", "cancelled"],
      needs_review: ["done", "in_progress", "cancelled"],
      done: [],
      failed: [],
      cancelled: [],
    });
  });

  it("creates an in-progress task with attempt 1", async () => {
    const store = makeStore();
    const task = await createOwnerTask(newTaskInput(store));
    expect(task.status).toBe("in_progress");
    expect(task.attemptCount).toBe(1);
    expect(task.resultVersion).toBe(0);
    expect((await store.read()).tasks).toHaveLength(1);
  });

  it("stores the worker result and bumps resultVersion on needs_review", async () => {
    const store = makeStore();
    const task = await createOwnerTask(newTaskInput(store));
    const result = await transitionOwnerTask({
      store,
      taskId: task.taskId,
      to: "needs_review",
      actor: "worker",
      resultText: "pricing table",
      artifacts: [{ kind: "file", path: "/tmp/pricing.md" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.task.status).toBe("needs_review");
    expect(result.task.resultText).toBe("pricing table");
    expect(result.task.resultVersion).toBe(1);
    expect(result.task.artifacts).toHaveLength(1);
  });

  it("rejects an accept without a reviewed resultVersion", async () => {
    const store = makeStore();
    const task = await createOwnerTask(newTaskInput(store));
    await transitionOwnerTask({
      store,
      taskId: task.taskId,
      to: "needs_review",
      actor: "worker",
      resultText: "v1",
    });
    const result = await transitionOwnerTask({
      store,
      taskId: task.taskId,
      to: "done",
      actor: "owner",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe("result_version_required");
  });

  it("refuses a stale resultVersion", async () => {
    const store = makeStore();
    const task = await createOwnerTask(newTaskInput(store));
    await transitionOwnerTask({
      store,
      taskId: task.taskId,
      to: "needs_review",
      actor: "worker",
      resultText: "v1",
    });
    // Reject and produce v2.
    await transitionOwnerTask({
      store,
      taskId: task.taskId,
      to: "in_progress",
      actor: "owner",
      reviewNote: "fix it",
    });
    await transitionOwnerTask({
      store,
      taskId: task.taskId,
      to: "needs_review",
      actor: "worker",
      resultText: "v2",
    });
    const stale = await transitionOwnerTask({
      store,
      taskId: task.taskId,
      to: "done",
      actor: "owner",
      expectedResultVersion: 1,
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) {
      return;
    }
    expect(stale.code).toBe("result_version_stale");

    const fresh = await transitionOwnerTask({
      store,
      taskId: task.taskId,
      to: "done",
      actor: "owner",
      expectedResultVersion: 2,
    });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) {
      return;
    }
    expect(fresh.task.status).toBe("done");
    expect(fresh.task.acceptedBy).toBe("owner");
    expect(fresh.task.resultVersion).toBe(2);
  });

  it("passes the review note back and increments attemptCount on rejection", async () => {
    const store = makeStore();
    const task = await createOwnerTask(newTaskInput(store));
    await transitionOwnerTask({
      store,
      taskId: task.taskId,
      to: "needs_review",
      actor: "worker",
      resultText: "v1",
    });
    const rejected = await transitionOwnerTask({
      store,
      taskId: task.taskId,
      to: "in_progress",
      actor: "owner",
      reviewNote: "add citations",
      maxAttempts: 3,
    });
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) {
      return;
    }
    expect(rejected.task.status).toBe("in_progress");
    expect(rejected.task.attemptCount).toBe(2);
    expect(rejected.task.reviewNote).toBe("add citations");
  });

  it("marks the task failed after the attempt budget is exhausted", async () => {
    const store = makeStore();
    const task = await createOwnerTask(newTaskInput(store));
    await transitionOwnerTask({
      store,
      taskId: task.taskId,
      to: "needs_review",
      actor: "worker",
      resultText: "v1",
    });
    const firstReject = await transitionOwnerTask({
      store,
      taskId: task.taskId,
      to: "in_progress",
      actor: "owner",
      maxAttempts: 2,
    });
    expect(firstReject.ok).toBe(true);
    await transitionOwnerTask({
      store,
      taskId: task.taskId,
      to: "needs_review",
      actor: "worker",
      resultText: "v2",
    });
    const secondReject = await transitionOwnerTask({
      store,
      taskId: task.taskId,
      to: "in_progress",
      actor: "owner",
      maxAttempts: 2,
    });
    expect(secondReject.ok).toBe(true);
    if (!secondReject.ok) {
      return;
    }
    expect(secondReject.task.status).toBe("failed");
    expect(secondReject.task.error).toContain("Maximum attempts");
  });

  it("rejects illegal transitions without writing", async () => {
    const store = makeStore();
    const task = await createOwnerTask(newTaskInput(store, { status: "pending" }));
    const before = (await store.read()).tasks[0]?.revision;
    const result = await transitionOwnerTask({
      store,
      taskId: task.taskId,
      to: "needs_review",
      actor: "worker",
      resultText: "nope",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe("illegal_transition");
    const after = (await store.read()).tasks[0];
    expect(after?.revision).toBe(before);
    expect(after?.status).toBe("pending");
  });

  it("only auto-accepts explicitly configured cron tasks", async () => {
    const store = makeStore();
    const userTask = await createOwnerTask(newTaskInput(store));
    await transitionOwnerTask({
      store,
      taskId: userTask.taskId,
      to: "needs_review",
      actor: "worker",
      resultText: "v1",
    });
    const forbidden = await transitionOwnerTask({
      store,
      taskId: userTask.taskId,
      to: "done",
      actor: AUTO_ACCEPT_ACTOR,
      expectedResultVersion: 1,
    });
    expect(forbidden.ok).toBe(false);
    if (forbidden.ok) {
      return;
    }
    expect(forbidden.code).toBe("auto_accept_forbidden");

    const cronTask = await createOwnerTask({
      ...newTaskInput(store),
      source: { kind: "cron", autoAccept: true },
    });
    await transitionOwnerTask({
      store,
      taskId: cronTask.taskId,
      to: "needs_review",
      actor: "cron",
      resultText: "monitor ok",
    });
    const accepted = await transitionOwnerTask({
      store,
      taskId: cronTask.taskId,
      to: "done",
      actor: AUTO_ACCEPT_ACTOR,
      expectedResultVersion: 1,
    });
    expect(accepted.ok).toBe(true);

    // A card created before autoAccept was enabled on the job must still close
    // when the current run is configured to auto-accept.
    const legacyCronTask = await createOwnerTask({
      ...newTaskInput(store),
      source: { kind: "cron" },
    });
    await transitionOwnerTask({
      store,
      taskId: legacyCronTask.taskId,
      to: "needs_review",
      actor: "cron",
      resultText: "monitor ok",
    });
    const legacyAccepted = await transitionOwnerTask({
      store,
      taskId: legacyCronTask.taskId,
      to: "done",
      actor: AUTO_ACCEPT_ACTOR,
      expectedResultVersion: 1,
    });
    expect(legacyAccepted.ok).toBe(true);
  });

  it("forbids auto-accepting sensitive identity/payment tasks", async () => {
    const store = makeStore();
    for (const sensitivity of ["identity", "payment", "credentials"] as const) {
      const task = await createOwnerTask({
        ...newTaskInput(store),
        source: { kind: "cron" },
        sensitivity,
      });
      await transitionOwnerTask({
        store,
        taskId: task.taskId,
        to: "needs_review",
        actor: "cron",
        resultText: "done",
      });
      const auto = await transitionOwnerTask({
        store,
        taskId: task.taskId,
        to: "done",
        actor: AUTO_ACCEPT_ACTOR,
        expectedResultVersion: 1,
      });
      expect(auto.ok).toBe(false);
      if (auto.ok) {
        continue;
      }
      expect(auto.code).toBe("auto_accept_forbidden");
      // A human can still accept it explicitly.
      const human = await transitionOwnerTask({
        store,
        taskId: task.taskId,
        to: "done",
        actor: "owner:ou_owner",
        expectedResultVersion: 1,
      });
      expect(human.ok).toBe(true);
    }
  });

  it("serializes concurrent accepts (one winner, no lost revisions)", async () => {
    const store = makeStore();
    const task = await createOwnerTask(newTaskInput(store));
    await transitionOwnerTask({
      store,
      taskId: task.taskId,
      to: "needs_review",
      actor: "worker",
      resultText: "v1",
    });
    const revision = (await store.read()).tasks[0]!.revision;
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () =>
        transitionOwnerTask({
          store,
          taskId: task.taskId,
          to: "done",
          actor: "owner",
          expectedResultVersion: 1,
          expectedRevision: revision,
        }),
      ),
    );
    expect(attempts.filter((entry) => entry.ok)).toHaveLength(1);
    expect(attempts.filter((entry) => !entry.ok && entry.code === "conflict")).toHaveLength(9);
  });

  it("persists across store instances", async () => {
    const store = makeStore();
    const task = await createOwnerTask(newTaskInput(store));
    const reopened = createOwnerTaskStore({ filePath: store.filePath });
    const data = await reopened.read();
    expect(data.tasks.map((entry) => entry.taskId)).toEqual([task.taskId]);
  });

  it("finds tasks by worker run id or child session", async () => {
    const store = makeStore();
    const task = await createOwnerTask(newTaskInput(store));
    const data = await store.read();
    expect(findOwnerTaskByWorker(data, { runId: "run-1" })?.taskId).toBe(task.taskId);
    expect(findOwnerTaskByWorker(data, { childSessionKey: "agent:main:subagent:1" })?.taskId).toBe(
      task.taskId,
    );
  });

  it("cancels pending and in-progress tasks", async () => {
    const store = makeStore();
    for (const status of ["pending", "in_progress"] as const) {
      const task = await createOwnerTask(newTaskInput(store, { status }));
      const result = await transitionOwnerTask({
        store,
        taskId: task.taskId,
        to: "cancelled",
        actor: "owner",
      });
      expect(result.ok).toBe(true);
    }
  });

  it("reports not_found for unknown ids", async () => {
    const store = makeStore();
    const result = await transitionOwnerTask({
      store,
      taskId: "missing",
      to: "cancelled",
      actor: "owner",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe("not_found");
  });

  it("accepts only statuses present in the transition table", () => {
    const statuses: OwnerTaskStatus[] = [
      "pending",
      "in_progress",
      "needs_review",
      "done",
      "failed",
      "cancelled",
    ];
    for (const from of statuses) {
      for (const to of statuses) {
        const listed = OWNER_TASK_TRANSITIONS[from].includes(to);
        expect(typeof listed).toBe("boolean");
      }
    }
  });
});
