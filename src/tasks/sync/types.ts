import type { OwnerTaskRecord, OwnerTaskStatus } from "../owner/types.js";

/** Sync contract v1. Transport and storage stay in their own modules. */
export const SYNC_TASK_STATUSES = [
  "pending",
  "running",
  "waiting_input",
  "waiting_review",
  "done",
  "failed",
  "cancelled",
] as const;
export type SyncTaskStatus = (typeof SYNC_TASK_STATUSES)[number];
export type SyncSensitivity = "normal" | "identity" | "payment" | "credentials";

export type SyncTask = {
  id: string;
  goal: string;
  status: SyncTaskStatus;
  origin: "feishu" | "phone" | "esp32" | "web" | "allbot" | "charlie" | "cron";
  target: "auto" | "phone" | "cloud" | "mac" | "charlie";
  ownerId: string;
  deviceId?: string;
  conversation?: string;
  result?: {
    text?: string;
    artifact_ref?: string;
    verified?: boolean;
    verification_note?: string;
    unconfirmed?: string[];
  };
  progress?: {
    step?: number;
    note?: string;
    waiting_for?: string;
    question?: string;
    options?: string[];
  };
  sensitivity?: SyncSensitivity;
  version: number;
  idempotencyKey?: string;
  deliveryRef?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

export type SyncEvent = {
  taskId: string;
  deviceId: string;
  idempotencyKey: string;
  type:
    | "created"
    | "claimed"
    | "status"
    | "progress"
    | "answer"
    | "steer"
    | "cancel"
    | "review_accept"
    | "review_reject"
    | "result";
  fromVersion?: number;
  toVersion?: number;
  payload?: Record<string, unknown>;
  at: number;
};

export function syncStatusFromOwner(status: OwnerTaskStatus): SyncTaskStatus {
  return status === "in_progress"
    ? "running"
    : status === "needs_review"
      ? "waiting_review"
      : status;
}

export function syncTaskFromOwner(task: OwnerTaskRecord): SyncTask {
  const latest = task.events.at(-1);
  return {
    id: task.taskId,
    goal: task.goal,
    status: syncStatusFromOwner(task.status),
    origin:
      task.source.kind === "cron" ? "cron" : task.source.channel === "feishu" ? "feishu" : "allbot",
    target:
      task.execution?.environment === "device"
        ? "phone"
        : task.execution?.environment === "cloud"
          ? "cloud"
          : "mac",
    ownerId: task.ownerId,
    ...(task.execution?.deviceId ? { deviceId: task.execution.deviceId } : {}),
    ...(task.resultText !== null || task.artifacts.length > 0
      ? {
          result: {
            ...(task.resultText !== null ? { text: task.resultText } : {}),
            ...(task.artifacts[0]?.path ? { artifact_ref: task.artifacts[0].path } : {}),
            ...(task.reviewNote ? { verification_note: task.reviewNote } : {}),
          },
        }
      : {}),
    ...(latest?.note ? { progress: { note: latest.note } } : {}),
    sensitivity: task.sensitivity ?? "normal",
    version: task.revision,
    idempotencyKey: `owner-task:${task.taskId}:${task.revision}`,
    error: task.error,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export function ownerStatusFromSync(status: SyncTaskStatus): OwnerTaskStatus | null {
  return status === "running"
    ? "in_progress"
    : status === "waiting_review"
      ? "needs_review"
      : status === "waiting_input"
        ? null
        : status;
}

export function ownerTargetFromSync(
  target: SyncTask["target"],
  deviceId?: string,
): OwnerTaskRecord["execution"] | null {
  if (target === "cloud") {
    return { environment: "cloud", ...(deviceId ? { deviceId } : {}) };
  }
  if (target === "mac") {
    return { environment: "gateway", ...(deviceId ? { deviceId } : {}) };
  }
  return null;
}

export function assertSyncTransition(
  from: SyncTaskStatus,
  to: SyncTaskStatus,
  sensitivity: SyncSensitivity,
  actor: string,
): void {
  const allowed: Record<SyncTaskStatus, readonly SyncTaskStatus[]> = {
    pending: ["running", "cancelled"],
    running: ["waiting_input", "waiting_review", "done", "failed", "cancelled"],
    waiting_input: ["running", "cancelled"],
    waiting_review: ["done", "running", "cancelled"],
    done: [],
    failed: [],
    cancelled: [],
  };
  if (!allowed[from].includes(to)) {
    throw new Error(`illegal sync transition ${from} -> ${to}`);
  }
  if (from === "running" && to === "done" && sensitivity !== "normal") {
    throw new Error("sensitive task requires review");
  }
  if (from === "waiting_review" && to === "done" && !actor.startsWith("owner:")) {
    throw new Error("review acceptance requires human owner");
  }
}
