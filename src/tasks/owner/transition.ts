import { randomUUID } from "node:crypto";
import type { OwnerTaskStore } from "./store.js";
import { allocateOwnerTaskShortId } from "./store.js";
import {
  DEFAULT_OWNER_TASK_MAX_ATTEMPTS,
  OWNER_TASK_EVENT_LIMIT,
  type OwnerTaskArtifact,
  type OwnerTaskRecord,
  type OwnerTaskSource,
  type OwnerTaskStatus,
  type OwnerTaskStoreData,
  type OwnerTaskWorker,
} from "./types.js";

export const AUTO_ACCEPT_ACTOR = "system:auto-accept";

/**
 * Allowed status moves. `done` must come from an explicit acceptance, while
 * cron jobs with `source.autoAccept: true` may accept themselves through the
 * same edge with actor `system:auto-accept`.
 */
export const OWNER_TASK_TRANSITIONS: Readonly<Record<OwnerTaskStatus, readonly OwnerTaskStatus[]>> =
  {
    pending: ["in_progress", "cancelled"],
    in_progress: ["needs_review", "failed", "cancelled"],
    needs_review: ["done", "in_progress", "cancelled"],
    done: [],
    failed: [],
    cancelled: [],
  };

export function isLegalOwnerTaskTransition(from: OwnerTaskStatus, to: OwnerTaskStatus): boolean {
  return OWNER_TASK_TRANSITIONS[from].includes(to);
}

export type OwnerTaskTransitionErrorCode =
  | "not_found"
  | "conflict"
  | "illegal_transition"
  | "result_version_required"
  | "result_version_stale"
  | "auto_accept_forbidden"
  | "result_update_forbidden";

export type OwnerTaskTransitionResult =
  | { ok: true; task: OwnerTaskRecord }
  | {
      ok: false;
      code: OwnerTaskTransitionErrorCode;
      message: string;
      task?: OwnerTaskRecord;
    };

export type CreateOwnerTaskInput = {
  store: OwnerTaskStore;
  ownerId: string;
  routerSessionKey: string;
  title: string;
  goal: string;
  source: OwnerTaskSource;
  worker: OwnerTaskWorker;
  /** Defaults to in_progress when the worker is already dispatched. */
  status?: "pending" | "in_progress";
  resultText?: string | null;
  artifacts?: OwnerTaskArtifact[];
  sensitivity?: OwnerTaskRecord["sensitivity"];
  execution?: OwnerTaskRecord["execution"];
  taskId?: string;
  now?: number;
  actor?: string;
};

export type TransitionOwnerTaskInput = {
  store: OwnerTaskStore;
  taskId: string;
  to: OwnerTaskStatus;
  actor: string;
  note?: string;
  /** Required when moving to `done`; must match the version the user saw. */
  expectedResultVersion?: number;
  /** Optional compare-and-set against the record revision. */
  expectedRevision?: number;
  resultText?: string | null;
  artifacts?: OwnerTaskArtifact[];
  reviewNote?: string;
  worker?: Partial<OwnerTaskWorker>;
  maxAttempts?: number;
  now?: number;
};

function appendEvent(task: OwnerTaskRecord, event: OwnerTaskRecord["events"][number]): void {
  task.events.push(event);
  if (task.events.length > OWNER_TASK_EVENT_LIMIT) {
    task.events.splice(0, task.events.length - OWNER_TASK_EVENT_LIMIT);
  }
}

function findTask(data: OwnerTaskStoreData, idOrShortId: string): OwnerTaskRecord | undefined {
  return data.tasks.find((task) => task.taskId === idOrShortId || task.shortId === idOrShortId);
}

/** Periodic cron results replace the pending result without leaving needs_review. */
export async function updateOwnerTaskResult(input: {
  store: OwnerTaskStore;
  taskId: string;
  actor: string;
  resultText: string;
  artifacts?: OwnerTaskArtifact[];
  now?: number;
}): Promise<OwnerTaskTransitionResult> {
  return await input.store.update<OwnerTaskTransitionResult>((data) => {
    const task = findTask(data, input.taskId);
    if (!task) {
      return {
        data: null,
        result: { ok: false, code: "not_found", message: `Task ${input.taskId} not found.` },
      };
    }
    if (
      task.status !== "needs_review" ||
      task.source.kind !== "cron" ||
      input.actor !== "worker:cron"
    ) {
      return {
        data: null,
        result: {
          ok: false,
          code: "result_update_forbidden",
          message: "Result updates are only allowed for cron tasks awaiting review.",
          task,
        },
      };
    }
    const now = input.now ?? Date.now();
    task.resultText = input.resultText;
    task.artifacts = input.artifacts ?? [];
    task.resultVersion += 1;
    task.revision += 1;
    task.updatedAt = now;
    appendEvent(task, {
      at: now,
      from: "needs_review",
      to: "needs_review",
      actor: input.actor,
      note: `result v${task.resultVersion}`,
    });
    return { data, result: { ok: true, task } };
  });
}

export async function createOwnerTask(input: CreateOwnerTaskInput): Promise<OwnerTaskRecord> {
  const now = input.now ?? Date.now();
  const status = input.status ?? "in_progress";
  const resultText = input.resultText ?? null;
  const task: OwnerTaskRecord = {
    taskId: input.taskId ?? `task_${randomUUID()}`,
    ownerId: input.ownerId,
    routerSessionKey: input.routerSessionKey,
    title: input.title,
    goal: input.goal,
    source: input.source,
    worker: input.worker,
    ...(input.execution ? { execution: input.execution } : {}),
    ...(input.sensitivity ? { sensitivity: input.sensitivity } : {}),
    status,
    resultText,
    resultVersion: resultText ? 1 : 0,
    artifacts: input.artifacts ?? [],
    attemptCount: status === "in_progress" ? 1 : 0,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    events: [
      {
        at: now,
        from: "created",
        to: status,
        actor: input.actor ?? "system",
      },
    ],
  };
  await input.store.update((data) => {
    task.shortId = allocateOwnerTaskShortId(data);
    data.tasks.push(task);
    return { data, result: undefined };
  });
  return task;
}

export async function transitionOwnerTask(
  input: TransitionOwnerTaskInput,
): Promise<OwnerTaskTransitionResult> {
  const maxAttempts = input.maxAttempts ?? DEFAULT_OWNER_TASK_MAX_ATTEMPTS;
  const now = input.now ?? Date.now();

  return await input.store.update<OwnerTaskTransitionResult>((data) => {
    const task = findTask(data, input.taskId);
    if (!task) {
      return {
        data: null,
        result: { ok: false, code: "not_found", message: `Task ${input.taskId} not found.` },
      };
    }
    if (input.expectedRevision !== undefined && task.revision !== input.expectedRevision) {
      return {
        data: null,
        result: {
          ok: false,
          code: "conflict",
          message: `Task ${input.taskId} changed (revision ${task.revision} != ${input.expectedRevision}).`,
          task,
        },
      };
    }

    const from = task.status;
    let to = input.to;
    const cronRetry =
      from === "failed" &&
      to === "in_progress" &&
      task.source.kind === "cron" &&
      input.actor === "worker:cron" &&
      task.attemptCount <= maxAttempts;

    if (!cronRetry && !isLegalOwnerTaskTransition(from, to)) {
      return {
        data: null,
        result: {
          ok: false,
          code: "illegal_transition",
          message: `Illegal task transition ${from} -> ${to}.`,
          task,
        },
      };
    }

    if (to === "done") {
      if (input.actor === AUTO_ACCEPT_ACTOR) {
        // The job's current autoAccept setting is checked by the cron bridge.
        // The task record may predate that setting, so only the source kind is
        // enforced here; user-sourced tasks still cannot self-accept.
        if (task.source.kind !== "cron") {
          return {
            data: null,
            result: {
              ok: false,
              code: "auto_accept_forbidden",
              message: "autoAccept is only allowed for cron-sourced tasks.",
              task,
            },
          };
        }
        if (task.sensitivity && task.sensitivity !== "normal") {
          return {
            data: null,
            result: {
              ok: false,
              code: "auto_accept_forbidden",
              message: `Sensitive ${task.sensitivity} tasks require human review.`,
              task,
            },
          };
        }
      }
      if (input.expectedResultVersion === undefined) {
        return {
          data: null,
          result: {
            ok: false,
            code: "result_version_required",
            message: "Accepting a task requires the resultVersion the user reviewed.",
            task,
          },
        };
      }
      if (input.expectedResultVersion !== task.resultVersion) {
        return {
          data: null,
          result: {
            ok: false,
            code: "result_version_stale",
            message: `Result changed (version ${task.resultVersion} != ${input.expectedResultVersion}); ask the user to review again.`,
            task,
          },
        };
      }
    }

    let eventNote = input.note;

    if (from === "needs_review" && to === "in_progress") {
      const nextAttempt = task.attemptCount + 1;
      task.attemptCount = nextAttempt;
      task.reviewNote = input.reviewNote ?? input.note;
      if (nextAttempt > maxAttempts) {
        to = "failed";
        eventNote = `Maximum attempts (${maxAttempts}) exceeded after user rejection.`;
        task.error = eventNote;
      }
    }

    if (to === "needs_review") {
      if (input.resultText !== undefined) {
        task.resultText = input.resultText;
      }
      task.artifacts = input.artifacts ?? [];
      task.resultVersion += 1;
      task.reviewNote = undefined;
      task.error = undefined;
    }

    if (to === "failed") {
      task.error = input.note ?? input.resultText ?? task.error ?? "Task failed.";
    }

    if (to === "done") {
      task.acceptedAt = now;
      task.acceptedBy = input.actor;
      task.reviewNote = undefined;
      task.error = undefined;
    }

    if (input.worker) {
      task.worker = { ...task.worker, ...input.worker };
    }

    task.status = to;
    task.revision += 1;
    task.updatedAt = now;
    appendEvent(task, {
      at: now,
      from,
      to,
      actor: input.actor,
      ...(eventNote ? { note: eventNote } : {}),
    });
    return { data, result: { ok: true, task } };
  });
}

/** Finds the most recent task owned by a worker identity. */
export function findOwnerTaskByWorker(
  data: OwnerTaskStoreData,
  match: { runId?: string; cronJobId?: string; childSessionKey?: string },
): OwnerTaskRecord | undefined {
  return data.tasks.toReversed().find((task) => {
    if (match.runId && task.worker.runId === match.runId) {
      return true;
    }
    if (match.cronJobId && task.worker.cronJobId === match.cronJobId) {
      return true;
    }
    if (match.childSessionKey && task.worker.childSessionKey === match.childSessionKey) {
      return true;
    }
    return false;
  });
}
