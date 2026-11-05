import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../test/helpers/import-fresh.js";

type LoggerModule = typeof import("./logger.js");

const originalGetBuiltinModule = (
  process as NodeJS.Process & { getBuiltinModule?: (id: string) => unknown }
).getBuiltinModule;

async function importBrowserSafeLogger(params?: {
  resolvePreferredAllBotTmpDir?: ReturnType<typeof vi.fn>;
}): Promise<{
  module: LoggerModule;
  resolvePreferredAllBotTmpDir: ReturnType<typeof vi.fn>;
}> {
  const resolvePreferredAllBotTmpDir =
    params?.resolvePreferredAllBotTmpDir ??
    vi.fn(() => {
      throw new Error("resolvePreferredAllBotTmpDir should not run during browser-safe import");
    });

  vi.doMock("../infra/tmp-allbot-dir.js", async () => {
    const actual = await vi.importActual<typeof import("../infra/tmp-allbot-dir.js")>(
      "../infra/tmp-allbot-dir.js",
    );
    return {
      ...actual,
      resolvePreferredAllBotTmpDir,
    };
  });

  Object.defineProperty(process, "getBuiltinModule", {
    configurable: true,
    value: undefined,
  });

  const module = await importFreshModule<LoggerModule>(
    import.meta.url,
    "./logger.js?scope=browser-safe",
  );
  return { module, resolvePreferredAllBotTmpDir };
}

describe("logging/logger browser-safe import", () => {
  afterEach(() => {
    vi.doUnmock("../infra/tmp-allbot-dir.js");
    Object.defineProperty(process, "getBuiltinModule", {
      configurable: true,
      value: originalGetBuiltinModule,
    });
  });

  it("does not resolve the preferred temp dir at import time when node fs is unavailable", async () => {
    const { module, resolvePreferredAllBotTmpDir } = await importBrowserSafeLogger();

    expect(resolvePreferredAllBotTmpDir).not.toHaveBeenCalled();
    expect(module.DEFAULT_LOG_DIR).toBe("/tmp/allbot");
    expect(module.DEFAULT_LOG_FILE).toBe("/tmp/allbot/allbot.log");
  });

  it("disables file logging when imported in a browser-like environment", async () => {
    const { module, resolvePreferredAllBotTmpDir } = await importBrowserSafeLogger();

    expect(module.getResolvedLoggerSettings()).toMatchObject({
      level: "silent",
      file: "/tmp/allbot/allbot.log",
    });
    expect(module.isFileLogLevelEnabled("info")).toBe(false);
    expect(() => module.getLogger().info("browser-safe")).not.toThrow();
    expect(resolvePreferredAllBotTmpDir).not.toHaveBeenCalled();
  });
});
