import { createConfigIO, getRuntimeConfigSnapshot, type AllBotConfig } from "../config/config.js";

export function loadBrowserConfigForRuntimeRefresh(): AllBotConfig {
  return getRuntimeConfigSnapshot() ?? createConfigIO().loadConfig();
}
