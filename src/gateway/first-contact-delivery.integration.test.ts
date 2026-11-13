import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AllBotConfig } from "../config/config.js";
import { createFirstContactDeliveryParams } from "./first-contact-delivery.js";

const mocks = vi.hoisted(() => ({
  sendText: vi.fn(async () => ({ channel: "demo-channel", messageId: "m1" })),
}));

vi.mock("../channels/plugins/outbound/load.js", () => ({
  loadChannelOutboundAdapter: async () => ({
    sendText: mocks.sendText,
  }),
}));

describe("first-contact delivery and the crash-recovery queue", () => {
  const cfg = {} as AllBotConfig;
  let stateDir: string;
  let previousStateDir: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "allbot-first-contact-"));
    previousStateDir = process.env.ALLBOT_STATE_DIR;
    process.env.ALLBOT_STATE_DIR = stateDir;
    mocks.sendText.mockClear();
  });

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.ALLBOT_STATE_DIR;
    } else {
      process.env.ALLBOT_STATE_DIR = previousStateDir;
    }
  });

  it("sends without writing a delivery-queue entry that recovery could replay", async () => {
    const { deliverOutboundPayloads } = await import("../infra/outbound/deliver.js");
    const params = createFirstContactDeliveryParams(
      cfg,
      { channel: "demo-channel", to: "ou_alice" },
      "你好",
    );

    const results = await deliverOutboundPayloads(params);

    expect(results).toEqual([{ channel: "demo-channel", messageId: "m1" }]);
    expect(mocks.sendText).toHaveBeenCalledOnce();
    // Regression: a kill -9 between enqueue and ack used to leave a .json file
    // here; the next boot's recoverPendingDeliveries replayed the greeting even
    // though firstContactAt was already saved. skipQueue must leave no residue.
    await expect(fs.readdir(path.join(stateDir, "delivery-queue"))).rejects.toThrow();
  });
});
