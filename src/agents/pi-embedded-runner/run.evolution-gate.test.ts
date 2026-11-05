import { describe, expect, it } from "vitest";
import type { AllBotConfig } from "../../config/config.js";
import { isCognitiveEvolutionEnabled } from "./run.js";

describe("isCognitiveEvolutionEnabled", () => {
  it("defaults to enabled when config is missing", () => {
    expect(isCognitiveEvolutionEnabled(undefined)).toBe(true);
  });

  it("stays enabled when cognitive.evolution.enabled is undefined", () => {
    expect(isCognitiveEvolutionEnabled({ cognitive: { evolution: {} } } as AllBotConfig)).toBe(
      true,
    );
  });

  it("returns false when cognitive.evolution.enabled is false", () => {
    expect(
      isCognitiveEvolutionEnabled({
        cognitive: { evolution: { enabled: false } },
      } as AllBotConfig),
    ).toBe(false);
  });
});
