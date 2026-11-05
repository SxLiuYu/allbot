import { describe, expect, it } from "vitest";
import {
  ensureAllBotExecMarkerOnProcess,
  markAllBotExecEnv,
  ALLBOT_CLI_ENV_VALUE,
  ALLBOT_CLI_ENV_VAR,
} from "./allbot-exec-env.js";

describe("markAllBotExecEnv", () => {
  it("returns a cloned env object with the exec marker set", () => {
    const env = { PATH: "/usr/bin", ALLBOT_CLI: "0" };
    const marked = markAllBotExecEnv(env);

    expect(marked).toEqual({
      PATH: "/usr/bin",
      ALLBOT_CLI: ALLBOT_CLI_ENV_VALUE,
    });
    expect(marked).not.toBe(env);
    expect(env.ALLBOT_CLI).toBe("0");
  });
});

describe("ensureAllBotExecMarkerOnProcess", () => {
  it.each([
    {
      name: "mutates and returns the provided process env",
      env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
    },
    {
      name: "overwrites an existing marker on the provided process env",
      env: { PATH: "/usr/bin", [ALLBOT_CLI_ENV_VAR]: "0" } as NodeJS.ProcessEnv,
    },
  ])("$name", ({ env }) => {
    expect(ensureAllBotExecMarkerOnProcess(env)).toBe(env);
    expect(env[ALLBOT_CLI_ENV_VAR]).toBe(ALLBOT_CLI_ENV_VALUE);
  });

  it("defaults to mutating process.env when no env object is provided", () => {
    const previous = process.env[ALLBOT_CLI_ENV_VAR];
    delete process.env[ALLBOT_CLI_ENV_VAR];

    try {
      expect(ensureAllBotExecMarkerOnProcess()).toBe(process.env);
      expect(process.env[ALLBOT_CLI_ENV_VAR]).toBe(ALLBOT_CLI_ENV_VALUE);
    } finally {
      if (previous === undefined) {
        delete process.env[ALLBOT_CLI_ENV_VAR];
      } else {
        process.env[ALLBOT_CLI_ENV_VAR] = previous;
      }
    }
  });
});
