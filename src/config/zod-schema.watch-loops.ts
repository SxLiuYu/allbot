import { z } from "zod";

/** Low-cost always-on watchers: poll a URL and wake the Router only on change. */
export const WatchLoopsSchema = z
  .array(
    z
      .object({
        id: z.string().min(1),
        label: z.string().min(1).optional(),
        url: z.string().url().startsWith("https://"),
        intervalMs: z.number().int().min(60_000).max(24 * 60 * 60_000).optional(),
        sessionKey: z.string().min(1).optional(),
        instruction: z.string().optional(),
      })
      .strict(),
  )
  .max(20)
  .optional();
