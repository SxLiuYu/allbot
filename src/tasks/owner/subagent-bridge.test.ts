import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AllBotConfig } from "../../config/config.js";
import { createOwnerTaskStore } from "./store.js";
import { syncOwnerTaskFromSubagentCompletion } from "./subagent-bridge.js";
import { createOwnerTask } from "./transition.js";

const dirs: string[] = [];

function makeStore() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "owner-tasks-bridge-"));
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

function taskInput(store: ReturnType<typeof makeStore>) {
  return {
    store,
    ownerId: "ou_owner",
    routerSessionKey: "agent:main:main",
    title: "Subagent work",
    goal: "Do the work",
    source: { kind: "user" as const },
    worker: {
      kind: "subagent" as const,
      runId: "run-1",
      childSessionKey: "agent:main:subagent:1",
    },
  };
}

describe("syncOwnerTaskFromSubagentCompletion", () => {
  it("is a no-op when owner tasks are disabled", async () => {
    const store = makeStore();
    const task = await createOwnerTask(taskInput(store));
    const result = await syncOwnerTaskFromSubagentCompletion({
      store,
      cfg: DISABLED,
      runId: "run-1",
      childSessionKey: "agent:main:subagent:1",
      requesterSessionKey: "agent:main:main",
      outcomeStatus: "ok",
      resultText: "final text",
    });
    expect(result.synced).toBe(false);
    expect((await store.read()).tasks[0]?.status).toBe(task.status);
  });

  it("moves a successful run to needs_review and copies the result", async () => {
    const store = makeStore();
    const task = await createOwnerTask(taskInput(store));
    const result = await syncOwnerTaskFromSubagentCompletion({
      store,
      cfg: ENABLED,
      runId: "run-1",
      childSessionKey: "agent:main:subagent:1",
      requesterSessionKey: "agent:main:main",
      outcomeStatus: "ok",
      resultText: "final text",
    });
    expect(result).toEqual({ synced: true, reviewRequired: true, taskId: task.taskId });
    const stored = (await store.read()).tasks[0]!;
    expect(stored.status).toBe("needs_review");
    expect(stored.resultText).toBe("final text");
    expect(stored.resultVersion).toBe(1);
  });

  it("fails the task when the worker errored", async () => {
    const store = makeStore();
    await createOwnerTask(taskInput(store));
    const result = await syncOwnerTaskFromSubagentCompletion({
      store,
      cfg: ENABLED,
      runId: "run-1",
      childSessionKey: "agent:main:subagent:1",
      requesterSessionKey: "agent:main:main",
      outcomeStatus: "error",
      resultText: null,
    });
    expect(result.synced).toBe(true);
    expect(result.reviewRequired).toBe(false);
    const stored = (await store.read()).tasks[0]!;
    expect(stored.status).toBe("failed");
    expect(stored.error).toContain("failed");
  });

  it("does not overwrite a task that is already awaiting review", async () => {
    const store = makeStore();
    await createOwnerTask(taskInput(store));
    await syncOwnerTaskFromSubagentCompletion({
      store,
      cfg: ENABLED,
      runId: "run-1",
      childSessionKey: "agent:main:subagent:1",
      requesterSessionKey: "agent:main:main",
      outcomeStatus: "ok",
      resultText: "v1",
    });
    const again = await syncOwnerTaskFromSubagentCompletion({
      store,
      cfg: ENABLED,
      runId: "run-1",
      childSessionKey: "agent:main:subagent:1",
      requesterSessionKey: "agent:main:main",
      outcomeStatus: "ok",
      resultText: "v2",
    });
    expect(again.synced).toBe(false);
    expect((await store.read()).tasks[0]?.resultText).toBe("v1");
  });

  it("ignores runs that are not linked to a task", async () => {
    const store = makeStore();
    await createOwnerTask(taskInput(store));
    const result = await syncOwnerTaskFromSubagentCompletion({
      store,
      cfg: ENABLED,
      runId: "other-run",
      childSessionKey: "agent:main:subagent:other",
      requesterSessionKey: "agent:main:main",
      outcomeStatus: "ok",
      resultText: "hello",
    });
    expect(result.synced).toBe(false);
  });
});
