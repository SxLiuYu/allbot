import { describe, expect, it } from "vitest";
import type { KaijiBotConfig } from "../../config/config.js";
import { isCognitiveEvolutionEnabled } from "./run.js";

describe("isCognitiveEvolutionEnabled", () => {
  it("defaults to enabled when config is missing", () => {
    expect(isCognitiveEvolutionEnabled(undefined)).toBe(true);
  });

  it("stays enabled when cognitive.evolution.enabled is undefined", () => {
    expect(isCognitiveEvolutionEnabled({ cognitive: { evolution: {} } } as KaijiBotConfig)).toBe(
      true,
    );
  });

  it("returns false when cognitive.evolution.enabled is false", () => {
    expect(
      isCognitiveEvolutionEnabled({
        cognitive: { evolution: { enabled: false } },
      } as KaijiBotConfig),
    ).toBe(false);
  });
});
