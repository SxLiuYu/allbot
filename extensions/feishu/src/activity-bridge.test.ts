import { describe, expect, it, afterEach } from "vitest";
import { emitFeishuActivitySignal } from "./activity-bridge.js";

const ACTIVITY_BRIDGE_KEY = Symbol.for("allbot.cognitive.feishuActivityBridge");
type GlobalWithBridge = typeof globalThis & {
  [ACTIVITY_BRIDGE_KEY]?: { emit: (signal: unknown) => void };
};

describe("Feishu activity bridge", () => {
  afterEach(() => {
    delete (globalThis as GlobalWithBridge)[ACTIVITY_BRIDGE_KEY];
  });

  it("delivers a real inbound message signal to the installed bridge", () => {
    const received: unknown[] = [];
    (globalThis as GlobalWithBridge)[ACTIVITY_BRIDGE_KEY] = {
      emit: (signal) => received.push(signal),
    };

    emitFeishuActivitySignal({
      senderOpenId: "ou_test",
      chatId: "oc_test",
      chatType: "p2p",
      at: 12_345,
    });

    expect(received).toEqual([
      {
        senderOpenId: "ou_test",
        chatId: "oc_test",
        chatType: "p2p",
        at: 12_345,
      },
    ]);
  });

  it("is a no-op when the gateway has not installed the bridge", () => {
    expect(() => emitFeishuActivitySignal({ senderOpenId: "ou_test", at: 1 })).not.toThrow();
  });
});
