import { describe, expect, it } from "vitest";
import { CognitiveSchema } from "./zod-schema.cognitive.js";

describe("cognitive proactive first-contact config", () => {
  it("accepts explicit first-contact recipients", () => {
    const result = CognitiveSchema.safeParse({
      enabled: true,
      proactive: {
        enabled: true,
        firstContactEnabled: false,
        firstContactName: "刘工",
        firstContactTo: [{ channel: "feishu", to: "ou_alice", accountId: "default" }],
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data?.proactive?.firstContactTo).toEqual([
        { channel: "feishu", to: "ou_alice", accountId: "default" },
      ]);
      expect(result.data?.proactive?.firstContactEnabled).toBe(false);
      expect(result.data?.proactive?.firstContactName).toBe("刘工");
    }
  });

  it("allows the whole block to be omitted", () => {
    expect(CognitiveSchema.safeParse({ enabled: true, proactive: { enabled: true } }).success).toBe(
      true,
    );
  });

  it("rejects a malformed recipient", () => {
    expect(
      CognitiveSchema.safeParse({
        proactive: { enabled: true, firstContactTo: [{ channel: "feishu" }] },
      }).success,
    ).toBe(false);
  });
});
