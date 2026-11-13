import { listAgentIds } from "../../agents/agent-scope.js";
import type { AllBotConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PersonaTree } from "../types.js";
import { evaluateTaskCreationGate } from "./pacing.js";
import type { TaskStore, CreateTaskInput } from "./store.js";
import {
  clampText,
  DEFAULT_MAX_SUBTASKS,
  DEFAULT_MAX_TASK_DEPTH,
  isTerminalTaskStatus,
  TASK_RESULT_MAX_CHARS,
  type TaskRecord,
} from "./types.js";

const log = createSubsystemLogger("cognitive/tasks");
const TASK_CANCELLED_RESULT = "任务已取消";

/** Both the cognitive master switch and the tasks flag must be on. */
export function tasksEnabled(cfg: AllBotConfig | undefined): boolean {
  if (!cfg) {
    return false;
  }
  const cognitive = cfg.cognitive;
  if (cognitive?.enabled === false) {
    return false;
  }
  return cognitive?.tasks?.enabled === true;
}

export type CreateTaskResult =
  | { ok: true; task: TaskRecord }
  | {
      ok: false;
      code:
        | "disabled"
        | "pacing_vetoed"
        | "unknown_agent"
        | "parent_not_found"
        | "max_depth_exceeded"
        | "max_subtasks_exceeded";
      reason: string;
    };

export type CancelTaskResult =
  | { ok: true; task: TaskRecord }
  | { ok: false; code: "not_found" | "already_finished"; reason: string };

function taskLimits(config: AllBotConfig | undefined): {
  maxTaskDepth: number;
  maxSubTasks: number;
} {
  return {
    maxTaskDepth: config?.cognitive?.tasks?.maxTaskDepth ?? DEFAULT_MAX_TASK_DEPTH,
    maxSubTasks: config?.cognitive?.tasks?.maxSubTasks ?? DEFAULT_MAX_SUBTASKS,
  };
}

/**
 * Depth of a task in its parent chain (root = 1). Returns undefined when the
 * chain cannot be resolved (unknown id) and stops walking past maxDepth so a
 * corrupt cyclic chain cannot loop forever.
 */
async function resolveTaskDepth(
  store: TaskStore,
  userId: string,
  taskId: string,
  maxDepth: number,
): Promise<number | undefined> {
  let depth = 0;
  let cursor: string | undefined = taskId;
  while (cursor) {
    const found = await store.findTaskAcrossAgents(userId, cursor);
    if (!found) {
      return undefined;
    }
    depth += 1;
    if (depth > maxDepth) {
      return depth;
    }
    cursor = found.task.parentTaskId;
  }
  return depth;
}

export type TaskServiceDeps = {
  store: TaskStore;
  config: AllBotConfig | undefined;
  /** Fresh persona snapshot for the pacing gate (ledger U, suppressUntil). */
  loadPersona: (agentId: string, userId: string) => Promise<PersonaTree | undefined>;
  /** Kick after successful creation (heartbeat wake / scheduler nudge). */
  onTaskCreated?: (task: TaskRecord) => void | Promise<void>;
};

export type DelegateCreateInput = CreateTaskInput & {
  /**
   * Delegate the task to a different agent instance (M3 multi-agent): the
   * record is created in the target agent's namespace so its runner and step
   * driver execute the task on the target agent's session.
   */
  assignToAgent?: string;
};

/**
 * Task creation entry: flag gate → pacing gate → persist → kick.
 *
 * Pacing note (see pacing.ts): the ledger is cleared by the user-reply path,
 * so entry wiring for user-requested tasks must run AFTER the current turn's
 * post-turn persona extraction — otherwise a stale U can veto a direct
 * request.
 */
export async function createTaskSafely(
  deps: TaskServiceDeps,
  agentId: string,
  userId: string,
  input: DelegateCreateInput,
): Promise<CreateTaskResult> {
  if (!tasksEnabled(deps.config)) {
    return {
      ok: false,
      code: "disabled",
      reason: "cognitive.tasks.enabled is false — enable it to create tasks",
    };
  }

  const persona = await deps.loadPersona(agentId, userId);
  if (persona) {
    const gate = evaluateTaskCreationGate(persona);
    if (!gate.allowed) {
      log.info("task creation vetoed by pacing gate", {
        agentId,
        userId,
        reason: gate.reason ?? "pacing gate",
      });
      return { ok: false, code: "pacing_vetoed", reason: gate.reason ?? "pacing gate rejected" };
    }
  }
  // No persona yet = brand-new relationship: no ledger debt, no suppression.

  const targetAgentId = input.assignToAgent?.trim() || undefined;
  if (targetAgentId && targetAgentId !== agentId) {
    const knownAgents = listAgentIds(deps.config ?? ({} as AllBotConfig));
    if (!knownAgents.includes(targetAgentId)) {
      return {
        ok: false,
        code: "unknown_agent",
        reason: `agent "${targetAgentId}" is not configured (known: ${knownAgents.join(", ")})`,
      };
    }
  }

  const limits = taskLimits(deps.config);
  if (input.parentTaskId) {
    const parentDepth = await resolveTaskDepth(
      deps.store,
      userId,
      input.parentTaskId,
      limits.maxTaskDepth,
    );
    if (parentDepth === undefined) {
      return {
        ok: false,
        code: "parent_not_found",
        reason: `parent task ${input.parentTaskId} not found for user ${userId}`,
      };
    }
    if (parentDepth + 1 > limits.maxTaskDepth) {
      return {
        ok: false,
        code: "max_depth_exceeded",
        reason: `subtask depth ${parentDepth + 1} exceeds maxTaskDepth ${limits.maxTaskDepth}`,
      };
    }
    const siblings = await deps.store.listSubtasks(userId, input.parentTaskId);
    if (siblings.length >= limits.maxSubTasks) {
      return {
        ok: false,
        code: "max_subtasks_exceeded",
        reason: `parent task ${input.parentTaskId} already has ${siblings.length} subtasks (max ${limits.maxSubTasks})`,
      };
    }
  }

  const maxSteps = input.maxSteps ?? deps.config?.cognitive?.tasks?.maxSteps;
  const ownerAgentId = targetAgentId ?? agentId;
  const task = await deps.store.create(ownerAgentId, userId, {
    ...input,
    ...(input.parentTaskId ? { parentTaskId: input.parentTaskId, parentAgentId: agentId } : {}),
    ...(maxSteps !== undefined ? { maxSteps } : {}),
  });

  // Creating a subtask parks the parent until aggregation wakes it (M3): the
  // runner pauses on `blocked`, children run on their assigned agents.
  if (input.parentTaskId) {
    await deps.store.update(agentId, userId, input.parentTaskId, (parent) =>
      parent.status === "queued" || parent.status === "running"
        ? { ...parent, status: "blocked" }
        : parent,
    );
  }

  await deps.onTaskCreated?.(task);
  log.info("task created", {
    agentId: ownerAgentId,
    userId,
    taskId: task.id,
    goal: task.goal.slice(0, 80),
    ...(targetAgentId ? { assignedBy: agentId } : {}),
  });
  return { ok: true, task };
}

/**
 * User-initiated cancellation. The runner re-checks the persisted status
 * before every step, so a running task stops advancing at the next boundary
 * and a queued task is never claimed.
 *
 * Idempotent for an already-cancelled task; finished tasks are left alone.
 */
export async function cancelTask(
  store: TaskStore,
  agentId: string,
  userId: string,
  taskId: string,
): Promise<CancelTaskResult> {
  const updated = await store.update(agentId, userId, taskId, (task) => {
    if (isTerminalTaskStatus(task.status)) {
      return task;
    }
    return {
      ...task,
      status: "cancelled",
      result: clampText(TASK_CANCELLED_RESULT, TASK_RESULT_MAX_CHARS),
    };
  });
  if (!updated) {
    return {
      ok: false,
      code: "not_found",
      reason: `task ${taskId} not found for ${agentId}/${userId}`,
    };
  }
  if (updated.status !== "cancelled") {
    return {
      ok: false,
      code: "already_finished",
      reason: `task ${taskId} is already ${updated.status}`,
    };
  }
  log.info("task cancelled", { agentId, userId, taskId });
  return { ok: true, task: updated };
}
