import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

/**
 * Cognitive task system RPCs (M4 audit UX). Additive protocol surface: the
 * Control UI task panel lists active tasks and inspects one task's full
 * execution trail (steps, budget, subtask results).
 */

export const TasksListParamsSchema = Type.Object(
  {
    /** Restrict to one agent's namespace (default: all agents). */
    agentId: Type.Optional(NonEmptyString),
    /** Restrict to one user (default: all users with task files). */
    userId: Type.Optional(NonEmptyString),
    /** Include terminal tasks (done/failed/halted/cancelled) in the snapshot. */
    includeFinished: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const TasksGetParamsSchema = Type.Object(
  {
    taskId: NonEmptyString,
    userId: NonEmptyString,
  },
  { additionalProperties: false },
);

/**
 * Cancel a queued/running/blocked task. `agentId` is optional: without it the
 * owning agent is resolved across namespaces (task ids are UUIDs).
 */
export const TasksCancelParamsSchema = Type.Object(
  {
    taskId: NonEmptyString,
    userId: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);
