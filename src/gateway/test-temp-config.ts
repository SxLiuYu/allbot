import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearConfigCache, resetConfigRuntimeState } from "../config/config.js";
import { clearSecretsRuntimeSnapshot } from "../secrets/runtime.js";

export async function withTempConfig(params: {
  cfg: unknown;
  run: () => Promise<void>;
  prefix?: string;
}): Promise<void> {
  const prevConfigPath = process.env.ALLBOT_CONFIG_PATH;
  const prevStateDir = process.env.ALLBOT_STATE_DIR;

  const dir = await mkdtemp(path.join(os.tmpdir(), params.prefix ?? "allbot-test-config-"));
  const configPath = path.join(dir, "allbot.json");

  process.env.ALLBOT_CONFIG_PATH = configPath;
  process.env.ALLBOT_STATE_DIR = path.join(dir, ".allbot");

  try {
    await writeFile(configPath, JSON.stringify(params.cfg, null, 2), "utf-8");
    clearConfigCache();
    resetConfigRuntimeState();
    clearSecretsRuntimeSnapshot();
    await params.run();
  } finally {
    if (prevConfigPath === undefined) {
      delete process.env.ALLBOT_CONFIG_PATH;
    } else {
      process.env.ALLBOT_CONFIG_PATH = prevConfigPath;
    }
    if (prevStateDir === undefined) {
      delete process.env.ALLBOT_STATE_DIR;
    } else {
      process.env.ALLBOT_STATE_DIR = prevStateDir;
    }
    clearConfigCache();
    resetConfigRuntimeState();
    clearSecretsRuntimeSnapshot();
    await rm(dir, { recursive: true, force: true });
  }
}
