import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { TaskStepOutcome } from "./runner.js";
import { clampText, TASK_SUMMARY_MAX_CHARS, type TaskRecord } from "./types.js";

const log = createSubsystemLogger("cognitive/tasks/step-driver");

/** How long a step may run before the awaiter gives up (agent turn + tools). */
export const STEP_TIMEOUT_MS_DEFAULT = 10 * 60 * 1000;

type StepAwaiter = {
  taskId: string;
  stepIndex: number;
  /** Owner of the in-flight step, checked against the reporting turn. */
  agentId?: string;
  userId?: string;
  sessionKey?: string;
  resolve: (outcome: TaskStepOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Identity of the turn that calls task_step_report (ownership check). */
export type TaskStepReporter = {
  agentId?: string;
  userId?: string;
  sessionKey?: string;
};

/**
 * In-process registry pairing runner steps with the task_step_report tool
 * call that ends them. One step of one task is in flight at a time per
 * process; a restart loses pending awaiters, and the runner's crash-recovery
 * path re-runs the uncheckpointed step — at-least-once, documented.
 */
const awaiters = new Map<string, StepAwaiter>();

function awaiterKey(taskId: string, stepIndex: number): string {
  return `${taskId}:${stepIndex}`;
}

export type ReportStepOutcomeResult = { delivered: true } | { delivered: false; reason: string };

/**
 * Verify the reporting turn belongs to the step's owner. A step is only
 * resolvable by the (agent, user, session) that the runner registered it for;
 * without this, any turn that knows/guesses a taskId + stepIndex could close
 * another user's step. Fields absent on either side are skipped.
 */
function ownerMismatch(awaiter: StepAwaiter, reporter?: TaskStepReporter): string | undefined {
  if (!reporter) {
    return undefined;
  }
  if (
    reporter.sessionKey !== undefined &&
    awaiter.sessionKey !== undefined &&
    reporter.sessionKey !== awaiter.sessionKey
  ) {
    return "session";
  }
  if (
    reporter.userId !== undefined &&
    awaiter.userId !== undefined &&
    reporter.userId !== awaiter.userId
  ) {
    return "user";
  }
  if (
    reporter.agentId !== undefined &&
    awaiter.agentId !== undefined &&
    reporter.agentId !== awaiter.agentId
  ) {
    return "agent";
  }
  return undefined;
}

/**
 * Called by the task_step_report agent tool: resolve the pending step.
 * Exported for the tool and for tests that simulate the agent turn.
 */
export function reportStepOutcome(
  params: {
    taskId: string;
    stepIndex: number;
    summary: string;
    done?: boolean;
    error?: string;
  },
  reporter?: TaskStepReporter,
): ReportStepOutcomeResult {
  const key = awaiterKey(params.taskId, params.stepIndex);
  const awaiter = awaiters.get(key);
  if (!awaiter) {
    return {
      delivered: false,
      reason: `No pending step ${params.stepIndex} for task ${params.taskId}`,
    };
  }
  const mismatch = ownerMismatch(awaiter, reporter);
  if (mismatch) {
    return {
      delivered: false,
      reason: `Step ${params.stepIndex} of task ${params.taskId} does not belong to this ${mismatch}`,
    };
  }
  awaiters.delete(key);
  clearTimeout(awaiter.timer);
  awaiter.resolve({
    summary: clampText(params.summary, TASK_SUMMARY_MAX_CHARS),
    ...(params.done ? { done: true } : {}),
    ...(params.error ? { error: clampText(params.error, 500) } : {}),
  });
  return { delivered: true };
}

/** Number of in-flight step awaiters (diagnostics/tests). */
export function pendingStepCount(): number {
  return awaiters.size;
}

export type ProductionStepDriverDeps = {
  /** Session the task's agent turns run on (the user's session). */
  sessionKey: string;
  enqueueSystemEvent: (
    text: string,
    options: { sessionKey: string; contextKey?: string },
  ) => boolean;
  requestHeartbeatNow: (opts: { reason: string; sessionKey: string }) => void;
  /**
   * Shared per-task workspace directory (M3): when the task participates in
   * a parent/subtask hierarchy, its path is included in the step prompt so
   * cooperating agents read/write the same WORKING_MEMORY.md.
   */
  resolveSharedTaskDir?: (task: TaskRecord) => string | undefined;
  stepTimeoutMs?: number;
};

export function buildStepPrompt(task: TaskRecord, stepIndex: number, sharedDir?: string): string {
  const progress = task.steps
    .map((s) => `  ${s.index}. ${s.summary}${s.error ? `（错误：${s.error}）` : ""}`)
    .join("\n");
  const progressBlock = progress ? `\n已完成步骤：\n${progress}` : "\n（这是第一步）";
  const subtaskBlock = task.subtaskResults?.length
    ? `\n子任务结果（已全部完成，请汇总进最终结果）：\n${task.subtaskResults
        .map(
          (s) =>
            `  - [${s.status}]（${s.agentId}）${s.goal}${s.result ? `：${clampText(s.result, 800)}` : ""}`,
        )
        .join("\n")}`
    : "";
  const sharedBlock =
    task.parentTaskId || task.subtaskResults?.length
      ? `\n共享工作区：${sharedDir ?? "（不可用）"}\n跨 agent 协作可通过该目录下的 WORKING_MEMORY.md 记录与读取进展（先读后追加）。`
      : "";
  return [
    `[Task Step ${stepIndex}/${task.budget.maxSteps}]`,
    `任务ID：${task.id}`,
    `任务目标：${task.goal}`,
    progressBlock,
    subtaskBlock,
    sharedBlock,
    "请立即执行本步骤的实际工作（可使用工具）。完成后调用 task_step_report 工具汇报本步结果：",
    `- taskId / stepIndex：使用上面的任务ID和步骤号（${stepIndex}）`,
    "- summary：本步做了什么、进展如何",
    "- done：目标已达成时为 true，并把最终结果写进 summary（summary 已含最终结果时应立即置 true，不必为凑满步骤数而留到后续步骤）",
    "- error：本步失败时填写原因",
    "每步的进度由系统自动汇报给用户，你无需发送中间进度消息；除非确实需要用户补充信息才能继续。",
  ].join("\n");
}

/**
 * Production step driver: one step = one agent turn on the user's session,
 * woken via the system-event + heartbeat idiom (same as insight delivery).
 * The turn's task_step_report tool call resolves the step outcome.
 */
export function createProductionStepDriver(deps: ProductionStepDriverDeps) {
  const timeoutMs = deps.stepTimeoutMs ?? STEP_TIMEOUT_MS_DEFAULT;
  return async function runStep(task: TaskRecord): Promise<TaskStepOutcome> {
    const stepIndex = task.budget.usedSteps + 1;
    const key = awaiterKey(task.id, stepIndex);

    const sharedDir = deps.resolveSharedTaskDir?.(task);
    const enqueued = deps.enqueueSystemEvent(buildStepPrompt(task, stepIndex, sharedDir), {
      sessionKey: deps.sessionKey,
      contextKey: `task:${task.id}:${stepIndex}`,
    });
    if (!enqueued) {
      return {
        summary: "",
        error: `Failed to enqueue system event for session ${deps.sessionKey}`,
      };
    }
    deps.requestHeartbeatNow({ reason: "cognitive-task", sessionKey: deps.sessionKey });

    return await new Promise<TaskStepOutcome>((resolve) => {
      const timer = setTimeout(() => {
        awaiters.delete(key);
        log.warn("task step timed out", { taskId: task.id, stepIndex });
        resolve({
          summary: "",
          error: `Step ${stepIndex} timed out after ${Math.round(timeoutMs / 60000)} minutes without task_step_report`,
        });
      }, timeoutMs);
      awaiters.set(key, {
        taskId: task.id,
        stepIndex,
        ...(task.agentId ? { agentId: task.agentId } : {}),
        ...(task.userId ? { userId: task.userId } : {}),
        sessionKey: deps.sessionKey,
        resolve,
        timer,
      });
    });
  };
}
