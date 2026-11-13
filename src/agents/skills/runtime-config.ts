import { getRuntimeConfigSnapshot, type AllBotConfig } from "../../config/config.js";

export function resolveSkillRuntimeConfig(config?: AllBotConfig): AllBotConfig | undefined {
  return getRuntimeConfigSnapshot() ?? config;
}
