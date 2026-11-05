import { describe, expect, it } from "vitest";
import { AllBotSchema } from "./zod-schema.js";

describe("AllBotSchema logging levels", () => {
  it("accepts valid logging level values for level and consoleLevel", () => {
    expect(() =>
      AllBotSchema.parse({
        logging: {
          level: "debug",
          consoleLevel: "warn",
        },
      }),
    ).not.toThrow();
  });

  it("rejects invalid logging level values", () => {
    expect(() =>
      AllBotSchema.parse({
        logging: {
          level: "loud",
        },
      }),
    ).toThrow();
    expect(() =>
      AllBotSchema.parse({
        logging: {
          consoleLevel: "verbose",
        },
      }),
    ).toThrow();
  });
});
