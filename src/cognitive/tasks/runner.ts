import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { TaskStore } from "./store.js";
import {
  clampText,
  DEFAULT_MAX_CONCURRENT_PER_USER,
  DEFAULT_MAX_CONCURRENT_TASKS,
  isTerminalTaskStatus,
  TASK_RESULT_MAX_CHARS,
  TASK_SUMMARY_MAX_CHARS,
  type TaskRecord,
  type TaskStep,
} from "./types.js";

const log = createSubsystemLogger("cognitive/tasks");

/** Outcome of one executed task step, produced by the agent-turn driver. */
export type TaskStepOutcome = {
  summary: string;
  /** The goal has been achieved; summary is the final result. */
  done?: boolean;
  /** Step failed; the runner marks the task failed and delivers the error. */
  error?: string;
};

export type TaskRunnerDeps = {
  store: TaskStore;
  /**
   * Execute one agent turn toward the task goal. Receives the task snapshot
   * including prior steps (progress context). Must NOT mutate the record.
   */
  runStep: (task: TaskRecord) => Promise<TaskStepOutcome>;
  /** Deliver a terminal notification (done/failed/halted) to the user. */
  deliver: (task: TaskRecord, message: string) => Promise<void>;
  /**
   * Report one non-terminal step to the user (chat-first progress
   * visibility — most users never see the Control UI). Called after the
   * step checkpoint, only for steps that continue the task; terminal
   * outcomes have their own `deliver` message. Errors are logged, never
   * propagated.
   */
  deliverProgress?: (task: TaskRecord, stepIndex: number, summary: string) => Promise<void>;
  /**
   * Called after any terminal transition with the final record (parent
   * aggregation, M3). Errors are logged, never propagated — the child's own
   * lifecycle must complete regardless.
   */
  onTaskTerminal?: (task: TaskRecord) => Promise<void> | void;
  now?: () => number;
  /** Concurrent drives allowed per (agentId, userId). Default 1. */
  maxConcurrentPerUser?: number;
  /** Global concurrent-drive ceiling across all users. */
  maxConcurrent?: number;
};

/**
 * Bounded task execution loop.
 *
 * Each tick claims the oldest runnable task (queued, or running from a
 * crashed prior process) and drives it to a terminal state, checkpointing
 * after every step. Budgets are hard brakes: reaching maxSteps or the
 * wall-clock ceiling halts the task with a partial-result notification
 * instead of running forever.
 *
 * Single-process assumption: one gateway process owns the loop; a stale
 * "running" task is resumed (steps are idempotent-ish from the checkpoint).
 */
export class TaskRunner {
  private readonly deps: TaskRunnerDeps;
  /**
   * In-flight ticks per `agentId/userId` plus a global count. One user's slow
   * step no longer blocks other users (the old single boolean serialized the
   * whole process), while each user still runs at most
   * `maxConcurrentPerUser` drives and the process keeps a global ceiling.
   */
  private readonly activeByUser = new Map<string, number>();
  private activeTotal = 0;
  /** Tasks currently being driven by this runner instance. */
  private readonly liveTaskIds = new Set<string>();

  constructor(deps: TaskRunnerDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Claim the oldest queued task, or a running task left behind by a crash.
   * Atomic claim via store.update under the scoped lock. A task already being
   * driven by this instance is skipped, so concurrent drives for one user
   * (maxConcurrentPerUser > 1) never double-run a task; a `running` record
   * not in the live set comes from a crashed process and is resumed.
   */
  private async claimNext(agentId: string, userId: string): Promise<TaskRecord | undefined> {
    const tasks = await this.deps.store.list(agentId, userId);
    const runnable = tasks
      .filter((t) => t.status === "queued" || t.status === "running")
      .toSorted((a, b) => a.createdAt - b.createdAt);
    if (runnable.length === 0) {
      return undefined;
    }
    for (const candidate of runnable) {
      // Reserved synchronously inside the store's lock, so two claim attempts
      // racing on the same record cannot both win.
      let reserved = false;
      let claimed: TaskRecord | undefined;
      try {
        claimed = await this.deps.store.update(agentId, userId, candidate.id, (task) => {
          if (task.status !== "queued" && task.status !== "running") {
            // Lost the claim race; caller re-reads.
            return task;
          }
          if (task.status === "running" && this.liveTaskIds.has(task.id)) {
            // Owned by a drive already running in this process.
            return task;
          }
          reserved = true;
          this.liveTaskIds.add(task.id);
          return {
            ...task,
            status: "running",
            budget: {
              ...task.budget,
              startedAt: task.budget.startedAt ?? this.now(),
            },
          };
        });
      } catch (err) {
        if (reserved) {
          this.liveTaskIds.delete(candidate.id);
        }
        throw err;
      }
      if (reserved && claimed?.status === "running") {
        return claimed;
      }
      if (reserved) {
        this.liveTaskIds.delete(candidate.id);
      }
    }
    return undefined;
  }

  private budgetExceeded(task: TaskRecord): { reason: "steps" | "wallclock" } | undefined {
    if (task.budget.usedSteps >= task.budget.maxSteps) {
      return { reason: "steps" };
    }
    if (
      task.budget.startedAt !== undefined &&
      this.now() - task.budget.startedAt > task.budget.maxWallClockMs
    ) {
      return { reason: "wallclock" };
    }
    return undefined;
  }

  private async halt(
    agentId: string,
    userId: string,
    task: TaskRecord,
    reason: "steps" | "wallclock",
  ): Promise<TaskRecord> {
    const message =
      reason === "steps"
        ? `任务「${task.goal}」达到步数上限（${task.budget.maxSteps} 步），已暂停。已完成 ${task.budget.usedSteps} 步。`
        : `任务「${task.goal}」超过时间预算（${Math.round(task.budget.maxWallClockMs / 60000)} 分钟），已暂停。已完成 ${task.budget.usedSteps} 步。`;
    const partial =
      task.steps
        .filter((s) => s.status === "ok")
        .map((s) => s.summary)
        .join("\n\n") || "无已完成步骤";
    const halted = await this.deps.store.update(agentId, userId, task.id, (current) =>
      isTerminalTaskStatus(current.status)
        ? current
        : {
            ...current,
            status: "halted" as const,
            result: clampText(partial, TASK_RESULT_MAX_CHARS),
          },
    );
    const finalTask = halted ?? task;
    if (finalTask.status !== "halted") {
      // A cancel (or another terminal transition) won the race.
      log.info("task not halted; status changed concurrently", {
        taskId: task.id,
        status: finalTask.status,
      });
      return finalTask;
    }
    await this.deps.deliver(finalTask, `${message}\n\n部分进展：\n${clampText(partial, 2000)}`);
    log.info("task halted", { taskId: task.id, reason, steps: finalTask.budget.usedSteps });
    await this.notifyTerminal(finalTask);
    return finalTask;
  }

  private async notifyTerminal(task: TaskRecord): Promise<void> {
    if (!this.deps.onTaskTerminal) {
      return;
    }
    try {
      await this.deps.onTaskTerminal(task);
    } catch (err) {
      log.warn("onTaskTerminal hook failed", { taskId: task.id, error: String(err) });
    }
  }

  /** Drive one task to a terminal state with checkpoints after every step. */
  private async drive(agentId: string, userId: string, task: TaskRecord): Promise<void> {
    let current = task;
    for (;;) {
      // Cancellation is checked before every step: re-read the persisted
      // record (cancelTask writes it) so a queued/running task stops at the
      // next boundary. The claim guard already excludes cancelled tasks.
      const latest = await this.deps.store.get(agentId, userId, current.id);
      if (!latest) {
        return;
      }
      if (latest.status === "cancelled") {
        log.info("task cancelled before step", {
          taskId: current.id,
          steps: latest.budget.usedSteps,
        });
        return;
      }
      current = latest;

      const exceeded = this.budgetExceeded(current);
      if (exceeded) {
        await this.halt(agentId, userId, current, exceeded.reason);
        return;
      }

      const stepIndex = current.budget.usedSteps + 1;
      const stepStartedAt = this.now();
      let outcome: TaskStepOutcome;
      try {
        outcome = await this.deps.runStep(current);
      } catch (err) {
        outcome = { summary: "", error: err instanceof Error ? err.message : String(err) };
      }

      const step: TaskStep = {
        index: stepIndex,
        startedAt: stepStartedAt,
        endedAt: this.now(),
        summary: clampText(outcome.summary, TASK_SUMMARY_MAX_CHARS),
        status: outcome.error ? "error" : "ok",
        ...(outcome.error ? { error: clampText(outcome.error, 500) } : {}),
      };

      // Checkpoint: persist the step before deciding the next transition, so
      // a crash mid-task loses at most one step of bookkeeping.
      const updated = await this.deps.store.update(agentId, userId, current.id, (t) => ({
        ...t,
        steps: [...t.steps, step],
        budget: {
          ...t.budget,
          usedSteps: t.budget.usedSteps + 1,
          lastStepAt: step.endedAt,
        },
      }));
      if (!updated) {
        // Task vanished (evicted/deleted) — stop silently.
        return;
      }
      current = updated;

      // A cancel that landed while the step was running wins over the step's
      // outcome: never flip a cancelled task to done/failed.
      if (updated.status === "cancelled") {
        log.info("task cancelled during step", { taskId: current.id, step: stepIndex });
        return;
      }

      if (outcome.error) {
        const message = `任务「${current.goal}」第 ${stepIndex} 步失败：${step.error ?? "unknown error"}`;
        const failed = await this.deps.store.update(agentId, userId, current.id, (t) =>
          isTerminalTaskStatus(t.status)
            ? t
            : {
                ...t,
                status: "failed" as const,
                result: clampText(message, TASK_RESULT_MAX_CHARS),
              },
        );
        if (!failed || failed.status !== "failed") {
          log.info("step failure not recorded; task status changed concurrently", {
            taskId: current.id,
            status: failed?.status ?? "missing",
          });
          return;
        }
        await this.deps.deliver(failed, message);
        log.warn("task step failed", { taskId: current.id, step: stepIndex });
        await this.notifyTerminal(failed);
        return;
      }

      if (outcome.done) {
        const message = `任务完成「${current.goal}」：\n${step.summary}`;
        const doneTask = await this.deps.store.update(agentId, userId, current.id, (t) =>
          isTerminalTaskStatus(t.status)
            ? t
            : {
                ...t,
                status: "done" as const,
                result: clampText(step.summary, TASK_RESULT_MAX_CHARS),
              },
        );
        if (!doneTask || doneTask.status !== "done") {
          log.info("step completion not recorded; task status changed concurrently", {
            taskId: current.id,
            status: doneTask?.status ?? "missing",
          });
          return;
        }
        await this.deps.deliver(doneTask, message);
        log.info("task done", { taskId: current.id, steps: current.budget.usedSteps });
        await this.notifyTerminal(doneTask);
        return;
      }

      // Non-terminal step: report progress (chat-first visibility). Fires for
      // continuing and blocked-pausing steps; done/error have their own
      // terminal delivery and must not double-notify.
      if (this.deps.deliverProgress) {
        try {
          await this.deps.deliverProgress(current, stepIndex, step.summary);
        } catch (err) {
          log.warn("task progress delivery failed", {
            taskId: current.id,
            step: stepIndex,
            error: String(err),
          });
        }
      }

      // The step delegated subtasks (creation flips this task to `blocked`):
      // pause driving here — aggregation wakes the parent when children reach
      // terminal states (M3 multi-agent).
      if (updated.status === "blocked") {
        log.info("task paused waiting on subtasks", { taskId: current.id });
        return;
      }
      // Not done, budget remains — continue to the next step.
    }
  }

  /**
   * One scheduler pass: drive at most `maxTasksPerTick` tasks to terminal
   * state. Concurrent ticks are allowed for different users; for the same
   * user a tick that finds the user already running returns 0 immediately
   * (the next scheduled pass picks the queue up), so one slow step cannot
   * stack duplicate drives. The global ceiling bounds total in-flight work.
   */
  async tick(agentId: string, userId: string, maxTasksPerTick = 1): Promise<number> {
    const userKey = `${agentId}/${userId}`;
    const perUserLimit = this.deps.maxConcurrentPerUser ?? DEFAULT_MAX_CONCURRENT_PER_USER;
    const globalLimit = this.deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_TASKS;
    const perUserActive = this.activeByUser.get(userKey) ?? 0;
    if (perUserActive >= perUserLimit || this.activeTotal >= globalLimit) {
      return 0;
    }
    this.activeByUser.set(userKey, perUserActive + 1);
    this.activeTotal += 1;
    let progressed = 0;
    try {
      while (progressed < maxTasksPerTick) {
        const claimed = await this.claimNext(agentId, userId);
        if (!claimed) {
          break;
        }
        try {
          await this.drive(agentId, userId, claimed);
        } finally {
          this.liveTaskIds.delete(claimed.id);
        }
        progressed++;
      }
    } finally {
      const remaining = (this.activeByUser.get(userKey) ?? 1) - 1;
      if (remaining <= 0) {
        this.activeByUser.delete(userKey);
      } else {
        this.activeByUser.set(userKey, remaining);
      }
      this.activeTotal -= 1;
    }
    return progressed;
  }
}
