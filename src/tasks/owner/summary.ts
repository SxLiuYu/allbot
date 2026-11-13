import { formatDurationCompact } from "../../infra/format-time/format-duration.ts";
import { resolveOwnerTaskDisplayId } from "./store.js";
import type { OwnerTaskRecord } from "./types.js";

export const OWNER_TASK_SUMMARY_LIMIT = 8;
export const OWNER_TASK_SUMMARY_TITLE_MAX = 72;
export const OWNER_TASK_SUMMARY_PROGRESS_MAX = 140;
/** Stale review cards stop consuming Router context after one day. */
export const OWNER_TASK_SUMMARY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function truncate(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function progressOf(task: OwnerTaskRecord): string {
  const raw =
    task.status === "needs_review"
      ? (task.resultText ?? task.goal)
      : (task.reviewNote ?? task.resultText ?? task.goal);
  return truncate(raw, OWNER_TASK_SUMMARY_PROGRESS_MAX);
}

/**
 * Builds the Router-session context block. Only active work is injected
 * (in_progress + needs_review), capped at 8 entries and at fixed character
 * budgets so a worker transcript can never leak into the main context.
 */
export function buildOwnerTaskSummarySection(
  tasks: readonly OwnerTaskRecord[],
  options: { limit?: number; now?: number } = {},
): string {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? OWNER_TASK_SUMMARY_LIMIT;
  const active = tasks
    .filter(
      (task) =>
        (task.status === "in_progress" || task.status === "needs_review") &&
        now - task.updatedAt <= OWNER_TASK_SUMMARY_MAX_AGE_MS,
    )
    .toSorted((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);

  if (active.length === 0) {
    return "";
  }

  const lines = ["## Active Tasks"];
  for (const task of active) {
    const elapsed = formatDurationCompact(Math.max(0, now - task.createdAt), {
      spaced: true,
    });
    const timing = elapsed ? `, ${elapsed}` : "";
    lines.push(
      `- [${resolveOwnerTaskDisplayId(task)}] ${truncate(task.title, OWNER_TASK_SUMMARY_TITLE_MAX)} — ` +
        `${task.status} (attempt ${task.attemptCount}${timing})`,
    );
    const progress = progressOf(task);
    if (progress) {
      lines.push(`  ${progress}`);
    }
  }
  if (active.some((task) => task.status === "needs_review")) {
    lines.push(
      "",
      "用户可以用自然语言验收或打回任务：",
      "- 「验收 task-x」→ 先 task_get 取 resultVersion，再 task_accept(taskId, resultVersion)。",
      "  不得凭记忆填 resultVersion，不得在未读结果的情况下验收。",
      "- 「打回 task-x，<反馈>」→ task_reject(taskId, feedback)。",
      "- 「取消 task-x」→ task_cancel(taskId)。",
      "只有用户明确表达验收意图时才调用；不要自行判断任务已完成。",
    );
  }
  return lines.join("\n");
}
