import { describe, expect, it } from "vitest";
import type { AllBotConfig } from "../config/config.js";
import { createFirstContactDeliveryParams } from "./first-contact-delivery.js";

const cfg = { session: { store: "/tmp/sessions.json" } } as AllBotConfig;

describe("createFirstContactDeliveryParams", () => {
  it("bypasses the write-ahead queue so recovery cannot replay the greeting", () => {
    const params = createFirstContactDeliveryParams(
      cfg,
      { channel: "feishu", to: "ou_alice" },
      "你好，我是 AllBot。",
    );

    // Regression: a kill -9 during the send used to leave a queue entry behind;
    // recoverPendingDeliveries then replayed it on the next boot even though
    // firstContactAt was already persisted, producing a duplicate greeting.
    expect(params.skipQueue).toBe(true);
    expect(params.cfg).toBe(cfg);
    expect(params.channel).toBe("feishu");
    expect(params.to).toBe("ou_alice");
    expect(params.payloads).toEqual([{ text: "你好，我是 AllBot。" }]);
  });

  it("carries accountId when configured and omits it otherwise", () => {
    expect(
      createFirstContactDeliveryParams(
        cfg,
        { channel: "feishu", to: "ou_alice", accountId: "bot-2" },
        "hello",
      ).accountId,
    ).toBe("bot-2");
    expect(
      createFirstContactDeliveryParams(cfg, { channel: "feishu", to: "ou_alice" }, "hello")
        .accountId,
    ).toBeUndefined();
  });
});
