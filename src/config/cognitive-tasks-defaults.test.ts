import { describe, expect, it } from "vitest";
import type { AllBotConfig } from "./config.js";
import { applyCognitiveDefaults } from "./defaults.js";
import { CognitiveSchema } from "./zod-schema.cognitive.js";

const base = { agents: { defaults: {} } } as unknown as AllBotConfig;

describe("cognitive defaults", () => {
  it("fills proactive defaults even when the cognitive section is absent", () => {
    const cfg = applyCognitiveDefaults(base);
    expect(cfg.cognitive?.enabled).toBe(true);
    expect(cfg.cognitive?.proactive?.enabled).toBe(false);
    expect(cfg.cognitive?.proactive?.activeHours?.start).toBe("09:00");
    expect(cfg.cognitive?.proactive?.activeHours?.end).toBe("22:00");
    expect(cfg.cognitive?.proactive?.minIntervalHours).toBe(0.5);
  });

  it("fills activeHours when proactive is present but partial", () => {
    const cfg = applyCognitiveDefaults({
      ...base,
      cognitive: { proactive: { enabled: true, activeHours: { start: "08:00" } } },
    } as AllBotConfig);
    expect(cfg.cognitive?.proactive?.enabled).toBe(true);
    expect(cfg.cognitive?.proactive?.activeHours?.start).toBe("08:00");
    expect(cfg.cognitive?.proactive?.activeHours?.end).toBe("22:00");
  });

  it("fills tasks defaults as disabled with sub-task brakes", () => {
    const cfg = applyCognitiveDefaults({
      ...base,
      cognitive: { enabled: true },
    } as AllBotConfig);
    expect(cfg.cognitive?.tasks?.enabled).toBe(false);
    expect(cfg.cognitive?.tasks?.maxSteps).toBe(12);
    expect(cfg.cognitive?.tasks?.progressMessages).toBe(false);
    expect(cfg.cognitive?.tasks?.maxSubTasks).toBe(3);
    expect(cfg.cognitive?.tasks?.maxTaskDepth).toBe(3);
    expect(cfg.cognitive?.tasks?.maxConcurrentPerUser).toBe(1);
  });

  it("preserves explicit values, including explicit opt-in", () => {
    const cfg = applyCognitiveDefaults({
      ...base,
      cognitive: {
        proactive: { enabled: true },
        tasks: { enabled: true, maxSteps: 3, progressMessages: true },
      },
    } as AllBotConfig);
    expect(cfg.cognitive?.proactive?.enabled).toBe(true);
    expect(cfg.cognitive?.tasks?.enabled).toBe(true);
    expect(cfg.cognitive?.tasks?.maxSteps).toBe(3);
    expect(cfg.cognitive?.tasks?.progressMessages).toBe(true);

    const optedOut = applyCognitiveDefaults({
      ...base,
      cognitive: { tasks: { enabled: false } },
    } as unknown as AllBotConfig);
    expect(optedOut.cognitive?.tasks?.enabled).toBe(false);
  });

  it("fills insight and evolution defaults when those sections are present", () => {
    const cfg = applyCognitiveDefaults({
      ...base,
      cognitive: { insight: {}, evolution: {} },
    } as AllBotConfig);
    expect(cfg.cognitive?.insight?.maxLlmCallsPerDelivery).toBe(3);
    expect(cfg.cognitive?.insight?.maxCandidatesPerEvent).toBe(2);
    expect(cfg.cognitive?.insight?.verificationLevel).toBe("basic");
    expect(cfg.cognitive?.evolution?.requireApproval).toBe(true);
  });

  it("zod schema applies the disabled-by-default flags and caps", () => {
    const parsed = CognitiveSchema.parse({ proactive: {}, tasks: {}, insight: {}, evolution: {} });
    expect(parsed?.proactive?.enabled).toBe(false);
    expect(parsed?.tasks?.enabled).toBe(false);
    expect(parsed?.tasks?.progressMessages).toBe(false);
    expect(parsed?.tasks?.maxSubTasks).toBe(3);
    expect(parsed?.tasks?.maxTaskDepth).toBe(3);
    expect(parsed?.tasks?.maxConcurrentPerUser).toBe(1);
    expect(parsed?.insight?.maxLlmCallsPerDelivery).toBe(3);
    expect(parsed?.insight?.maxCandidatesPerEvent).toBe(2);
    expect(parsed?.evolution?.requireApproval).toBe(true);

    expect(() => CognitiveSchema.parse({ tasks: { unknownKey: true } })).toThrow();
  });
});
