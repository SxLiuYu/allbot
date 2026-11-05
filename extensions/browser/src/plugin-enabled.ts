import type { AllBotConfig } from "allbot/plugin-sdk/browser-config-runtime";
import {
  normalizePluginsConfig,
  resolveEffectiveEnableState,
} from "allbot/plugin-sdk/browser-config-runtime";

export function isDefaultBrowserPluginEnabled(cfg: AllBotConfig): boolean {
  return resolveEffectiveEnableState({
    id: "browser",
    origin: "bundled",
    config: normalizePluginsConfig(cfg.plugins),
    rootConfig: cfg,
    enabledByDefault: true,
  }).enabled;
}
