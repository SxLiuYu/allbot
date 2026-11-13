import { describe, expect, it } from "vitest";
import { CognitiveSchema } from "./zod-schema.cognitive.js";

/**
 * The proactive layer only starts when `cognitive.enabled` and
 * `cognitive.proactive.enabled` are both true, so turning reply-side text
 * injection off has to be expressible without disabling the scheduler.
 */
describe("cognitive reply-injection switches", () => {
  it("keeps the proactive layer while disabling handshake and correction", () => {
    const result = CognitiveSchema.safeParse({
      enabled: true,
      proactive: { enabled: true },
      handshake: { enabled: false },
      correction: { enabled: false },
      evolution: { enabled: false },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data?.proactive?.enabled).toBe(true);
      expect(result.data?.handshake?.enabled).toBe(false);
      expect(result.data?.correction?.enabled).toBe(false);
      expect(result.data?.evolution?.enabled).toBe(false);
    }
  });

  it("accepts a handshake gap threshold", () => {
    const result = CognitiveSchema.safeParse({ handshake: { minGapHours: 12 } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data?.handshake?.minGapHours).toBe(12);
    }
  });

  it("still rejects unknown keys inside handshake", () => {
    expect(CognitiveSchema.safeParse({ handshake: { enabledd: false } }).success).toBe(false);
  });

  it("rejects a negative handshake gap", () => {
    expect(CognitiveSchema.safeParse({ handshake: { minGapHours: -1 } }).success).toBe(false);
  });

  it("accepts epsilonGreedy inside proactive", () => {
    const result = CognitiveSchema.safeParse({ proactive: { enabled: true, epsilonGreedy: 0.2 } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data?.proactive?.epsilonGreedy).toBe(0.2);
    }
  });
});
