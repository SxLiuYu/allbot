import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCliCommand } from "./command-format.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";

describe("parseCliProfileArgs", () => {
  it("leaves gateway --dev for subcommands", () => {
    const res = parseCliProfileArgs(["node", "allbot", "gateway", "--dev", "--allow-unconfigured"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual(["node", "allbot", "gateway", "--dev", "--allow-unconfigured"]);
  });

  it("leaves gateway --dev for subcommands after leading root options", () => {
    const res = parseCliProfileArgs([
      "node",
      "allbot",
      "--no-color",
      "gateway",
      "--dev",
      "--allow-unconfigured",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual([
      "node",
      "allbot",
      "--no-color",
      "gateway",
      "--dev",
      "--allow-unconfigured",
    ]);
  });

  it("still accepts global --dev before subcommand", () => {
    const res = parseCliProfileArgs(["node", "allbot", "--dev", "gateway"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("dev");
    expect(res.argv).toEqual(["node", "allbot", "gateway"]);
  });

  it("parses --profile value and strips it", () => {
    const res = parseCliProfileArgs(["node", "allbot", "--profile", "work", "status"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "allbot", "status"]);
  });

  it("parses interleaved --profile after the command token", () => {
    const res = parseCliProfileArgs(["node", "allbot", "status", "--profile", "work", "--deep"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "allbot", "status", "--deep"]);
  });

  it("parses interleaved --dev after the command token", () => {
    const res = parseCliProfileArgs(["node", "allbot", "status", "--dev"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("dev");
    expect(res.argv).toEqual(["node", "allbot", "status"]);
  });

  it("rejects missing profile value", () => {
    const res = parseCliProfileArgs(["node", "allbot", "--profile"]);
    expect(res.ok).toBe(false);
  });

  it.each([
    ["--dev first", ["node", "allbot", "--dev", "--profile", "work", "status"]],
    ["--profile first", ["node", "allbot", "--profile", "work", "--dev", "status"]],
    ["interleaved after command", ["node", "allbot", "status", "--profile", "work", "--dev"]],
  ])("rejects combining --dev with --profile (%s)", (_name, argv) => {
    const res = parseCliProfileArgs(argv);
    expect(res.ok).toBe(false);
  });
});

describe("applyCliProfileEnv", () => {
  it("fills env defaults for dev profile", () => {
    const env: Record<string, string | undefined> = {};
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    const expectedStateDir = path.join(path.resolve("/home/peter"), ".allbot-dev");
    expect(env.ALLBOT_PROFILE).toBe("dev");
    expect(env.ALLBOT_STATE_DIR).toBe(expectedStateDir);
    expect(env.ALLBOT_CONFIG_PATH).toBe(path.join(expectedStateDir, "allbot.json"));
    expect(env.ALLBOT_GATEWAY_PORT).toBe("19001");
  });

  it("does not override explicit env values", () => {
    const env: Record<string, string | undefined> = {
      ALLBOT_STATE_DIR: "/custom",
      ALLBOT_GATEWAY_PORT: "19099",
    };
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    expect(env.ALLBOT_STATE_DIR).toBe("/custom");
    expect(env.ALLBOT_GATEWAY_PORT).toBe("19099");
    expect(env.ALLBOT_CONFIG_PATH).toBe(path.join("/custom", "allbot.json"));
  });

  it("uses ALLBOT_HOME when deriving profile state dir", () => {
    const env: Record<string, string | undefined> = {
      ALLBOT_HOME: "/srv/allbot-home",
      HOME: "/home/other",
    };
    applyCliProfileEnv({
      profile: "work",
      env,
      homedir: () => "/home/fallback",
    });

    const resolvedHome = path.resolve("/srv/allbot-home");
    expect(env.ALLBOT_STATE_DIR).toBe(path.join(resolvedHome, ".allbot-work"));
    expect(env.ALLBOT_CONFIG_PATH).toBe(path.join(resolvedHome, ".allbot-work", "allbot.json"));
  });
});

describe("formatCliCommand", () => {
  it.each([
    {
      name: "no profile is set",
      cmd: "allbot doctor --fix",
      env: {},
      expected: "allbot doctor --fix",
    },
    {
      name: "profile is default",
      cmd: "allbot doctor --fix",
      env: { ALLBOT_PROFILE: "default" },
      expected: "allbot doctor --fix",
    },
    {
      name: "profile is Default (case-insensitive)",
      cmd: "allbot doctor --fix",
      env: { ALLBOT_PROFILE: "Default" },
      expected: "allbot doctor --fix",
    },
    {
      name: "profile is invalid",
      cmd: "allbot doctor --fix",
      env: { ALLBOT_PROFILE: "bad profile" },
      expected: "allbot doctor --fix",
    },
    {
      name: "--profile is already present",
      cmd: "allbot --profile work doctor --fix",
      env: { ALLBOT_PROFILE: "work" },
      expected: "allbot --profile work doctor --fix",
    },
    {
      name: "--dev is already present",
      cmd: "allbot --dev doctor",
      env: { ALLBOT_PROFILE: "dev" },
      expected: "allbot --dev doctor",
    },
  ])("returns command unchanged when $name", ({ cmd, env, expected }) => {
    expect(formatCliCommand(cmd, env)).toBe(expected);
  });

  it("inserts --profile flag when profile is set", () => {
    expect(formatCliCommand("allbot doctor --fix", { ALLBOT_PROFILE: "work" })).toBe(
      "allbot --profile work doctor --fix",
    );
  });

  it("trims whitespace from profile", () => {
    expect(formatCliCommand("allbot doctor --fix", { ALLBOT_PROFILE: "  jballbot  " })).toBe(
      "allbot --profile jballbot doctor --fix",
    );
  });

  it("handles command with no args after allbot", () => {
    expect(formatCliCommand("allbot", { ALLBOT_PROFILE: "test" })).toBe("allbot --profile test");
  });

  it("handles pnpm wrapper", () => {
    expect(formatCliCommand("pnpm allbot doctor", { ALLBOT_PROFILE: "work" })).toBe(
      "pnpm allbot --profile work doctor",
    );
  });

  it("inserts --container when a container hint is set", () => {
    expect(
      formatCliCommand("allbot gateway status --deep", { ALLBOT_CONTAINER_HINT: "demo" }),
    ).toBe("allbot --container demo gateway status --deep");
  });

  it("ignores unsafe container hints", () => {
    expect(
      formatCliCommand("allbot gateway status --deep", {
        ALLBOT_CONTAINER_HINT: "demo; rm -rf /",
      }),
    ).toBe("allbot gateway status --deep");
  });

  it("preserves both --container and --profile hints", () => {
    expect(
      formatCliCommand("allbot doctor", {
        ALLBOT_CONTAINER_HINT: "demo",
        ALLBOT_PROFILE: "work",
      }),
    ).toBe("allbot --container demo doctor");
  });

  it("does not prepend --container for update commands", () => {
    expect(formatCliCommand("allbot update", { ALLBOT_CONTAINER_HINT: "demo" })).toBe(
      "allbot update",
    );
    expect(
      formatCliCommand("pnpm allbot update --channel beta", { ALLBOT_CONTAINER_HINT: "demo" }),
    ).toBe("pnpm allbot update --channel beta");
  });
});
