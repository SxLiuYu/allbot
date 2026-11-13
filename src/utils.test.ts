import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "./test-helpers/temp-dir.js";
import {
  ensureDir,
  resolveConfigDir,
  resolveHomeDir,
  resolveUserPath,
  shortenHomeInString,
  shortenHomePath,
  sleep,
} from "./utils.js";

describe("ensureDir", () => {
  it("creates nested directory", async () => {
    await withTempDir({ prefix: "allbot-test-" }, async (tmp) => {
      const target = path.join(tmp, "nested", "dir");
      await ensureDir(target);
      expect(fs.existsSync(target)).toBe(true);
    });
  });
});

describe("sleep", () => {
  it("resolves after delay using fake timers", async () => {
    vi.useFakeTimers();
    const promise = sleep(1000);
    vi.advanceTimersByTime(1000);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});

describe("resolveConfigDir", () => {
  it("prefers ~/.allbot when legacy dir is missing", async () => {
    await withTempDir({ prefix: "allbot-config-dir-" }, async (root) => {
      const newDir = path.join(root, ".allbot");
      await fs.promises.mkdir(newDir, { recursive: true });
      const resolved = resolveConfigDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(newDir);
    });
  });

  it("expands ALLBOT_STATE_DIR using the provided env", () => {
    const env = {
      HOME: "/tmp/allbot-home",
      ALLBOT_STATE_DIR: "~/state",
    } as NodeJS.ProcessEnv;

    expect(resolveConfigDir(env)).toBe(path.resolve("/tmp/allbot-home", "state"));
  });

  it("falls back to the config file directory when only ALLBOT_CONFIG_PATH is set", () => {
    const env = {
      HOME: "/tmp/allbot-home",
      ALLBOT_CONFIG_PATH: "~/profiles/dev/allbot.json",
    } as NodeJS.ProcessEnv;

    expect(resolveConfigDir(env)).toBe(path.resolve("/tmp/allbot-home", "profiles", "dev"));
  });
});

describe("resolveHomeDir", () => {
  it("prefers ALLBOT_HOME over HOME", () => {
    vi.stubEnv("ALLBOT_HOME", "/srv/allbot-home");
    vi.stubEnv("HOME", "/home/other");

    expect(resolveHomeDir()).toBe(path.resolve("/srv/allbot-home"));

    vi.unstubAllEnvs();
  });
});

describe("shortenHomePath", () => {
  it("uses $ALLBOT_HOME prefix when ALLBOT_HOME is set", () => {
    vi.stubEnv("ALLBOT_HOME", "/srv/allbot-home");
    vi.stubEnv("HOME", "/home/other");

    expect(shortenHomePath(`${path.resolve("/srv/allbot-home")}/.allbot/allbot.json`)).toBe(
      "$ALLBOT_HOME/.allbot/allbot.json",
    );

    vi.unstubAllEnvs();
  });
});

describe("shortenHomeInString", () => {
  it("uses $ALLBOT_HOME replacement when ALLBOT_HOME is set", () => {
    vi.stubEnv("ALLBOT_HOME", "/srv/allbot-home");
    vi.stubEnv("HOME", "/home/other");

    expect(
      shortenHomeInString(`config: ${path.resolve("/srv/allbot-home")}/.allbot/allbot.json`),
    ).toBe("config: $ALLBOT_HOME/.allbot/allbot.json");

    vi.unstubAllEnvs();
  });
});

describe("resolveUserPath", () => {
  it("expands ~ to home dir", () => {
    expect(resolveUserPath("~", {}, () => "/Users/thoffman")).toBe(path.resolve("/Users/thoffman"));
  });

  it("expands ~/ to home dir", () => {
    expect(resolveUserPath("~/allbot", {}, () => "/Users/thoffman")).toBe(
      path.resolve("/Users/thoffman", "allbot"),
    );
  });

  it("resolves relative paths", () => {
    expect(resolveUserPath("tmp/dir")).toBe(path.resolve("tmp/dir"));
  });

  it("prefers ALLBOT_HOME for tilde expansion", () => {
    vi.stubEnv("ALLBOT_HOME", "/srv/allbot-home");
    vi.stubEnv("HOME", "/home/other");

    expect(resolveUserPath("~/allbot")).toBe(path.resolve("/srv/allbot-home", "allbot"));

    vi.unstubAllEnvs();
  });

  it("uses the provided env for tilde expansion", () => {
    const env = {
      HOME: "/tmp/allbot-home",
      ALLBOT_HOME: "/srv/allbot-home",
    } as NodeJS.ProcessEnv;

    expect(resolveUserPath("~/allbot", env)).toBe(path.resolve("/srv/allbot-home", "allbot"));
  });

  it("keeps blank paths blank", () => {
    expect(resolveUserPath("")).toBe("");
    expect(resolveUserPath("   ")).toBe("");
  });

  it("returns empty string for undefined/null input", () => {
    expect(resolveUserPath(undefined as unknown as string)).toBe("");
    expect(resolveUserPath(null as unknown as string)).toBe("");
  });
});
