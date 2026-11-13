import { describe, expect, it } from "vitest";
import type { AllBotConfig } from "../config/config.js";
import { isUpdatePlanToolEnabledForAllBotTools } from "./allbot-tools.registration.js";
import { createUpdatePlanTool } from "./tools/update-plan-tool.js";

describe("allbot-tools update_plan gating", () => {
  it("keeps update_plan disabled by default", () => {
    expect(isUpdatePlanToolEnabledForAllBotTools({} as AllBotConfig)).toBe(false);
  });

  it("registers update_plan when explicitly enabled", () => {
    const config = {
      tools: {
        experimental: {
          planTool: true,
        },
      },
    } as AllBotConfig;

    expect(isUpdatePlanToolEnabledForAllBotTools(config)).toBe(true);
    expect(createUpdatePlanTool().displaySummary).toBe("Track a short structured work plan.");
  });

  it("auto-enables update_plan for OpenAI-family providers", () => {
    expect(isUpdatePlanToolEnabledForAllBotTools({} as AllBotConfig, "openai")).toBe(true);
    expect(isUpdatePlanToolEnabledForAllBotTools({} as AllBotConfig, "openai-codex")).toBe(true);
    expect(isUpdatePlanToolEnabledForAllBotTools({} as AllBotConfig, "anthropic")).toBe(false);
  });

  it("lets config disable update_plan auto-enable", () => {
    const config = {
      tools: {
        experimental: {
          planTool: false,
        },
      },
    } as AllBotConfig;

    expect(isUpdatePlanToolEnabledForAllBotTools(config, "openai")).toBe(false);
  });
});
