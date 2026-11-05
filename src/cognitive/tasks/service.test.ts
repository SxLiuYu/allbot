import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KaijiBotConfig } from "../../config/config.js";
import type { PersonaTree } from "../types.js";
import { cancelTask, createTaskSafely, tasksEnabled, type TaskServiceDeps } from "./service.js";
import { TaskStore } from "./store.js";

const AGENT = "main";
const USER = "test-user";

function cfg(tasks?: {
  enabled?: boolean;
  maxSteps?: number;
  maxTaskDepth?: number;
  maxSubTasks?: number;
}): KaijiBotConfig {
  return { cognitive: { enabled: true, tasks } } as unknown as KaijiBotConfig;
}

function personaWithLedger(consecutiveNoResponses: number): PersonaTree {
  return {
    feedbackProfile: {
      topicBandits: {},
      optimalFrequencyHours: 48,
      lastProactiveAt: 0,
      recentInsightIds: [],
      recentInsightContents: [],
      consecutiveNoResponses,
    },
    rapport: {
      trustScore: 0.9,
      totalExchanges: 50,
      avgResponseLength: 100,
      selfDisclosureLevel: 0.5,
    },
    lifecycle: { stage: "active", lastActiveAt: 0, lastStageTransitionAt: 0, totalActiveDays: 30 },
    domains: {},
  } as unknown as PersonaTree;
}

describe("createTaskSafely", () => {
  let tempDir: string;
  let store: TaskStore;
  let kicked: string[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "kaijibot-task-service-"));
    store = new TaskStore(tempDir);
    kicked = [];
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function deps(
    overrides?: Partial<{
      config: KaijiBotConfig;
      persona: PersonaTree | undefined;
    }>,
  ): TaskServiceDeps {
    return {
      store,
      config: overrides?.config ?? cfg({ enabled: true }),
      loadPersona: async () => overrides?.persona,
      onTaskCreated: async (task) => {
        kicked.push(task.id);
      },
    };
  }

  it("rejects creation when the tasks flag is off (default)", async () => {
    expect(tasksEnabled(undefined)).toBe(false);
    expect(tasksEnabled(cfg(undefined))).toBe(false);
    expect(tasksEnabled(cfg({}))).toBe(false);

    const result = await createTaskSafely(deps({ config: cfg({}) }), AGENT, USER, {
      goal: "x",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("disabled");
    }
  });

  it("rejects creation when cognitive master switch is off even if tasks.enabled is true", async () => {
    const master = {
      cognitive: { enabled: false, tasks: { enabled: true } },
    } as unknown as KaijiBotConfig;
    expect(tasksEnabled(master)).toBe(false);
  });

  it("creates, kicks, and applies config maxSteps when healthy", async () => {
    const result = await createTaskSafely(
      deps({ config: cfg({ enabled: true, maxSteps: 5 }), persona: personaWithLedger(0) }),
      AGENT,
      USER,
      { goal: "整理周报" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task.status).toBe("queued");
      expect(result.task.budget.maxSteps).toBe(5);
      expect(kicked).toEqual([result.task.id]);
    }
  });

  it("vetoes creation at ledger U >= 3 with a pacing reason (T3)", async () => {
    const result = await createTaskSafely(deps({ persona: personaWithLedger(3) }), AGENT, USER, {
      goal: "不该创建",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("pacing_vetoed");
      expect(result.reason).toContain("cap 3");
    }
    expect(kicked).toHaveLength(0);
    expect(await store.list(AGENT, USER)).toHaveLength(0);
  });

  it("allows creation when no persona exists yet (fresh relationship)", async () => {
    const result = await createTaskSafely(deps({ persona: undefined }), AGENT, USER, {
      goal: "首次任务",
    });
    expect(result.ok).toBe(true);
  });

  describe("subtask guards", () => {
    async function createRoot(): Promise<string> {
      const root = await createTaskSafely(deps(), AGENT, USER, { goal: "根任务" });
      expect(root.ok).toBe(true);
      return root.ok ? root.task.id : "";
    }

    async function createChild(parentTaskId: string) {
      return createTaskSafely(deps(), AGENT, USER, {
        goal: `子任务-${parentTaskId.slice(-4)}`,
        parentTaskId,
      });
    }

    it("allows depth 1→2→3 and rejects depth 4", async () => {
      const root = await createRoot();
      const level2 = await createChild(root);
      expect(level2.ok).toBe(true);
      const level3 = await createChild(level2.ok ? level2.task.id : "");
      expect(level3.ok).toBe(true);

      const level4 = await createChild(level3.ok ? level3.task.id : "");
      expect(level4.ok).toBe(false);
      if (!level4.ok) {
        expect(level4.code).toBe("max_depth_exceeded");
        expect(level4.reason).toContain("maxTaskDepth 3");
      }
      expect(kicked).toHaveLength(3);
    });

    it("rejects the 4th subtask under one parent", async () => {
      const root = await createRoot();
      for (let i = 0; i < 3; i++) {
        expect((await createChild(root)).ok).toBe(true);
      }
      const fourth = await createChild(root);
      expect(fourth.ok).toBe(false);
      if (!fourth.ok) {
        expect(fourth.code).toBe("max_subtasks_exceeded");
        expect(fourth.reason).toContain("max 3");
      }
      expect(await store.listSubtasks(USER, root)).toHaveLength(3);
    });

    it("honors config overrides for depth and subtask caps", async () => {
      const root = await createRoot();
      const oneChildCfg = deps({ config: cfg({ enabled: true, maxSubTasks: 1 }) });
      expect(
        (await createTaskSafely(oneChildCfg, AGENT, USER, { goal: "子1", parentTaskId: root })).ok,
      ).toBe(true);
      const second = await createTaskSafely(oneChildCfg, AGENT, USER, {
        goal: "子2",
        parentTaskId: root,
      });
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.code).toBe("max_subtasks_exceeded");
      }

      const shallowCfg = deps({ config: cfg({ enabled: true, maxTaskDepth: 1 }) });
      const nested = await createTaskSafely(shallowCfg, AGENT, USER, {
        goal: "超深",
        parentTaskId: root,
      });
      expect(nested.ok).toBe(false);
      if (!nested.ok) {
        expect(nested.code).toBe("max_depth_exceeded");
      }
    });

    it("rejects a parentTaskId that does not exist for this user", async () => {
      const result = await createChild("task-missing");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("parent_not_found");
      }

      // A parent owned by another user is not visible either.
      const other = await store.create(AGENT, "other-user", { goal: "别人的父任务" });
      const crossUser = await createChild(other.id);
      expect(crossUser.ok).toBe(false);
      if (!crossUser.ok) {
        expect(crossUser.code).toBe("parent_not_found");
      }
    });
  });

  describe("cancelTask", () => {
    it("cancels a queued task and is idempotent", async () => {
      const created = await store.create(AGENT, USER, { goal: "待取消" });
      const first = await cancelTask(store, AGENT, USER, created.id);
      expect(first.ok).toBe(true);
      if (first.ok) {
        expect(first.task.status).toBe("cancelled");
        expect(first.task.result).toBe("任务已取消");
      }

      const again = await cancelTask(store, AGENT, USER, created.id);
      expect(again.ok).toBe(true);
      if (again.ok) {
        expect(again.task.status).toBe("cancelled");
      }
    });

    it("cancels a blocked parent", async () => {
      const parent = await store.create(AGENT, USER, { goal: "停靠父任务" });
      await store.update(AGENT, USER, parent.id, (t) => ({ ...t, status: "blocked" }));
      const result = await cancelTask(store, AGENT, USER, parent.id);
      expect(result.ok).toBe(true);
      expect((await store.get(AGENT, USER, parent.id))?.status).toBe("cancelled");
    });

    it("refuses to cancel a finished task", async () => {
      const created = await store.create(AGENT, USER, { goal: "已完成" });
      await store.update(AGENT, USER, created.id, (t) => ({
        ...t,
        status: "done",
        result: "结果",
      }));
      const result = await cancelTask(store, AGENT, USER, created.id);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("already_finished");
        expect(result.reason).toContain("done");
      }
      expect((await store.get(AGENT, USER, created.id))?.status).toBe("done");
    });

    it("reports not_found for another user's task", async () => {
      const created = await store.create(AGENT, "other-user", { goal: "别人的任务" });
      const result = await cancelTask(store, AGENT, USER, created.id);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("not_found");
      }
      expect((await store.get(AGENT, "other-user", created.id))?.status).toBe("queued");
    });
  });
});
