// Narrow plugin-sdk surface for the bundled diffs plugin.
// Keep this list additive and scoped to the bundled diffs surface.

export { definePluginEntry } from "./plugin-entry.js";
export type { AllBotConfig } from "../config/config.js";
export { resolvePreferredAllBotTmpDir } from "../infra/tmp-allbot-dir.js";
export type {
  AnyAgentTool,
  AllBotPluginApi,
  AllBotPluginConfigSchema,
  AllBotPluginToolContext,
  PluginLogger,
} from "../plugins/types.js";
