import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AllBotConfig } from "../../config/config.js";
import { tryResolveLoadedOutboundTarget } from "./targets-loaded.js";

const mocks = vi.hoisted(() => ({
  getLoadedChannelPlugin: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: mocks.getLoadedChannelPlugin,
}));

// Skip on CI: requires upstream-only channels/plugins not bundled in AllBot
describe.skipIf(process.env.CI)("tryResolveLoadedOutboundTarget", () => {
  beforeEach(() => {
    mocks.getLoadedChannelPlugin.mockReset();
  });

  it("returns undefined when no loaded plugin exists", () => {
    mocks.getLoadedChannelPlugin.mockReturnValue(undefined);

    expect(tryResolveLoadedOutboundTarget({ channel: "telegram", to: "123" })).toBeUndefined();
  });

  it("uses loaded plugin config defaultTo fallback", () => {
    const cfg: AllBotConfig = {
      channels: { telegram: { defaultTo: "123456789" } },
    };
    mocks.getLoadedChannelPlugin.mockReturnValue({
      id: "telegram",
      meta: { label: "Telegram" },
      capabilities: {},
      config: {
        resolveDefaultTo: ({ cfg }: { cfg: AllBotConfig }) => cfg.channels?.telegram?.defaultTo,
      },
      outbound: {},
      messaging: {},
    });

    expect(
      tryResolveLoadedOutboundTarget({
        channel: "telegram",
        to: "",
        cfg,
        mode: "implicit",
      }),
    ).toEqual({ ok: true, to: "123456789" });
  });
});
