import type { DeliveryContext } from "../../utils/delivery-context.js";

/**
 * Owner task lifecycle.
 *
 * One owner (a person, identified by the channel user id) has one Router
 * session. Tasks are the only externally visible work object; subagent and
 * cron runs are workers behind a task.
 *
 * Status is authoritative only in this record. Other modules must change it
 * through `transitionOwnerTask` (see ./transition.ts).
 */
export const OWNER_TASK_STATUSES = [
  "pending",
  "in_progress",
  "needs_review",
  "done",
  "failed",
  "cancelled",
] as const;

export type OwnerTaskStatus = (typeof OWNER_TASK_STATUSES)[number];

export type OwnerTaskSourceKind = "user" | "cron";

export type OwnerTaskSource = {
  kind: OwnerTaskSourceKind;
  channel?: string;
  /** Where review/accept/reject notifications should be delivered. */
  replyTo?: DeliveryContext;
  /**
   * Only honored for `kind === "cron"`. Lets unattended monitoring jobs close
   * themselves instead of piling up review cards.
   */
  autoAccept?: boolean;
};

export type OwnerTaskWorkerKind = "subagent" | "cron";

/**
 * Where long-running work executes and where identity-sensitive steps must be
 * handed back to a paired node. `device` and `cloud` are dispatched to paired
 * nodes by the deployment's device/cloud runners.
 */
export type OwnerTaskExecution = {
  environment?: "gateway" | "device" | "cloud";
  deviceId?: string;
  /** Set when a step needs local identity/session/payment data. */
  requiresDevice?: boolean;
  handoffNote?: string;
};

export type OwnerTaskWorker = {
  kind: OwnerTaskWorkerKind;
  /** Subagent run id, when known. */
  runId?: string;
  /** Cron job id, when the cron job is a worker. */
  cronJobId?: string;
  /** Session the worker runs in (subagent child session or cron run session). */
  childSessionKey: string;
};

export type OwnerTaskArtifact = {
  kind: string;
  label?: string;
  path?: string;
};

export type OwnerTaskEvent = {
  at: number;
  from: OwnerTaskStatus | "created";
  to: OwnerTaskStatus;
  actor: string;
  note?: string;
};

export type OwnerTaskRecord = {
  taskId: string;
  /** Human-typable id used in chat; lazily added for pre-shortId records. */
  shortId?: string;
  /** Stable owner identity (channel user id / operator id). */
  ownerId: string;
  /** The owner's Router session key. */
  routerSessionKey: string;
  title: string;
  goal: string;

  source: OwnerTaskSource;
  worker: OwnerTaskWorker;
  /** Optional cloud/device handoff intent. Absent means gateway-local work. */
  execution?: OwnerTaskExecution;
  /**
   * Sensitive tasks (identity, payment, credentials) must never be
   * auto-accepted. This is a policy marker, not a payment implementation.
   */
  sensitivity?: "normal" | "identity" | "payment" | "credentials";

  status: OwnerTaskStatus;
  /** Final worker output copied into the task; never a reference to a session. */
  resultText: string | null;
  /** Bumped every time a new result is stored. */
  resultVersion: number;
  artifacts: OwnerTaskArtifact[];

  reviewNote?: string;
  acceptedAt?: number;
  acceptedBy?: string;
  error?: string;

  attemptCount: number;
  /** Monotonic write counter, used for compare-and-set updates. */
  revision: number;
  createdAt: number;
  updatedAt: number;
  events: OwnerTaskEvent[];
};

export type OwnerTaskStoreData = {
  version: 1;
  tasks: OwnerTaskRecord[];
};

export const OWNER_TASK_STORE_VERSION = 1;
export const DEFAULT_OWNER_TASK_MAX_ATTEMPTS = 3;
export const DEFAULT_OWNER_TASK_MAX_ACTIVE = 8;
export const OWNER_TASK_EVENT_LIMIT = 50;
