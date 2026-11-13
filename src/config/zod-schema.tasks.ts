import { z } from "zod";

/**
 * Owner task lifecycle (Router -> Worker -> review).
 * Disabled by default so existing deployments keep their current behavior.
 */
export const TasksSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Maximum worker attempts before a rejected task is marked failed. */
    maxAttempts: z.number().int().min(1).max(10).default(3),
    /** Maximum concurrent in_progress tasks per owner. */
    maxActive: z.number().int().min(1).max(32).default(8),
    sync: z
      .object({
        enabled: z.boolean().default(false),
        baseUrl: z.string().url().optional(),
        tokenEnv: z
          .string()
          .regex(/^[A-Z_][A-Z0-9_]*$/)
          .default("ALLBOT_SYNC_GATEWAY_TOKEN"),
        deviceId: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();
