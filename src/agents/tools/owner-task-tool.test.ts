import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AllBotConfig } from "../../config/config.js";
import { createOwnerTaskStore } from "../../tasks/owner/store.js";
import { createOwnerTask, transitionOwnerTask } from "../../tasks/owner/transition.js";
import type { AnyAgentTool } from "./common.js";
import {
  createOwnerTaskAcceptTool,
  createOwnerTaskCancelTool,
  createOwnerTaskGetTool,
  createOwnerTaskListTool,
  createOwnerTaskRejectTool,
} from "./owner-task-tool.js";

const originalStateDir = process.env.ALLBOT_STATE_DIR;
let dir = "";

const ENABLED = {
  tasks: { enabled: true, maxAttempts: 2 },
} as AllBotConfig;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "owner-task-tool-"));
  process.env.ALLBOT_STATE_DIR = dir;
});

afterEach(() => {
  if (originalStateDir === undefined) {
    delete process.env.ALLBOT_STATE_DIR;
  } else {
    process.env.ALLBOT_STATE_DIR = originalStateDir;
  }
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function run(tool: AnyAgentTool, params: unknown) {
  const result = await tool.execute("call-1", params);
  return result.details as Record<string, unknown>;
}

async function seedTask(
  options: { status?: "in_progress" | "needs_review"; resultText?: string } = {},
) {
  const store = createOwnerTaskStore();
  const task = await createOwnerTask({
    store,
    ownerId: "operator",
    routerSessionKey: "agent:main:main",
    title: "Tool task",
    goal: "Do the thing",
    source: { kind: "user" },
    worker: {
      kind: "subagent",
      runId: "run-tool",
      childSessionKey: "agent:main:subagent:tool",
    },
  });
  if (options.status === "needs_review") {
    await transitionOwnerTask({
      store,
      taskId: task.taskId,
      to: "needs_review",
      actor: "worker",
      resultText: options.resultText ?? "result v1",
    });
  }
  return task.taskId;
}

describe("owner task tools", () => {
  it("returns disabled when tasks.enabled=false", async () => {
    const tool = createOwnerTaskListTool({
      config: {} as AllBotConfig,
      sessionKey: "agent:main:main",
    });
    const details = await run(tool, {});
    expect(details.status).toBe("disabled");
  });

  it("lists only this owner's active tasks", async () => {
    const taskId = await seedTask({ status: "needs_review" });
    const otherStore = createOwnerTaskStore();
    await createOwnerTask({
      store: otherStore,
      ownerId: "someone-else",
      routerSessionKey: "agent:main:other",
      title: "Hidden",
      goal: "hidden",
      source: { kind: "user" },
      worker: { kind: "subagent", runId: "r2", childSessionKey: "c2" },
    });
    const tool = createOwnerTaskListTool({
      config: ENABLED,
      sessionKey: "agent:main:main",
    });
    const details = await run(tool, {});
    const tasks = details.tasks as Array<{ taskId: string }>;
    expect(tasks.map((task) => task.taskId)).toEqual([taskId]);
  });

  it("returns the full result and version from task_get", async () => {
    const taskId = await seedTask({ status: "needs_review", resultText: "draft v1" });
    const details = await run(
      createOwnerTaskGetTool({ config: ENABLED, sessionKey: "agent:main:main" }),
      { taskId },
    );
    const task = details.task as { resultText: string; resultVersion: number };
    expect(task.resultText).toBe("draft v1");
    expect(task.resultVersion).toBe(1);
  });

  it("accepts with the reviewed version and refuses stale versions", async () => {
    const taskId = await seedTask({ status: "needs_review" });
    const tool = createOwnerTaskAcceptTool({ config: ENABLED, sessionKey: "agent:main:main" });
    const stale = await run(tool, { taskId, resultVersion: 2 });
    expect(stale.status).toBe("result_version_stale");
    const ok = await run(tool, { taskId, resultVersion: 1 });
    expect(ok.status).toBe("done");
  });

  it("rejects with feedback, bumps attempts, and re-invokes the worker", async () => {
    const taskId = await seedTask({ status: "needs_review" });
    const callGateway = vi.fn().mockResolvedValue({});
    const tool = createOwnerTaskRejectTool({
      config: ENABLED,
      sessionKey: "agent:main:main",
      callGateway: callGateway as never,
    });
    const details = await run(tool, { taskId, feedback: "add sources" });
    expect(details.status).toBe("in_progress");
    expect(details.attemptCount).toBe(2);
    expect(callGateway).toHaveBeenCalledTimes(1);
    const call = callGateway.mock.calls[0]![0] as {
      params: { sessionKey: string; message: string };
    };
    expect(call.params.sessionKey).toBe("agent:main:subagent:tool");
    expect(call.params.message).toContain("add sources");
  });

  it("fails after the attempt budget is exhausted", async () => {
    const taskId = await seedTask({ status: "needs_review" });
    const tool = createOwnerTaskRejectTool({
      config: ENABLED,
      sessionKey: "agent:main:main",
      callGateway: vi.fn().mockResolvedValue({}) as never,
    });
    await run(tool, { taskId, feedback: "one" });
    // Second attempt result.
    await transitionOwnerTask({
      store: createOwnerTaskStore(),
      taskId,
      to: "needs_review",
      actor: "worker",
      resultText: "v2",
    });
    const details = await run(tool, { taskId, feedback: "two" });
    expect(details.status).toBe("failed");
  });

  it("cancels a task", async () => {
    const taskId = await seedTask();
    const details = await run(
      createOwnerTaskCancelTool({ config: ENABLED, sessionKey: "agent:main:main" }),
      { taskId },
    );
    expect(details.status).toBe("cancelled");
  });

  it("does not expose another owner's task", async () => {
    const taskId = await seedTask({ status: "needs_review" });
    const details = await run(
      createOwnerTaskGetTool({ config: ENABLED, sessionKey: "agent:main:other" }),
      { taskId },
    );
    expect(details.status).toBe("not_found");
  });

  it("refuses to write when the tool has no owner identity", async () => {
    const taskId = await seedTask({ status: "needs_review" });
    const tool = createOwnerTaskAcceptTool({
      config: ENABLED,
      sessionKey: "agent:main:subagent:worker",
    });
    const details = await run(tool, { taskId, resultVersion: 1 });
    expect(details.status).toBe("no_owner_identity");
    expect((await createOwnerTaskStore().read()).tasks[0]?.status).toBe("needs_review");
  });
});
