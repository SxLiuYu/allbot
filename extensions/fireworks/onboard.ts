import {
  createDefaultModelsPresetAppliers,
  type AllBotConfig,
} from "allbot/plugin-sdk/provider-onboard";
import {
  buildFireworksCatalogModels,
  buildFireworksProvider,
  FIREWORKS_DEFAULT_MODEL_ID,
} from "./provider-catalog.js";

export const FIREWORKS_DEFAULT_MODEL_REF = `fireworks/${FIREWORKS_DEFAULT_MODEL_ID}`;

const fireworksPresetAppliers = createDefaultModelsPresetAppliers({
  primaryModelRef: FIREWORKS_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: AllBotConfig) => {
    const defaultProvider = buildFireworksProvider();
    return {
      providerId: "fireworks",
      api: defaultProvider.api ?? "openai-completions",
      baseUrl: defaultProvider.baseUrl,
      defaultModels: buildFireworksCatalogModels(),
      defaultModelId: FIREWORKS_DEFAULT_MODEL_ID,
      aliases: [{ modelRef: FIREWORKS_DEFAULT_MODEL_REF, alias: "Kimi K2.5 Turbo" }],
    };
  },
});

export function applyFireworksProviderConfig(cfg: AllBotConfig): AllBotConfig {
  return fireworksPresetAppliers.applyProviderConfig(cfg);
}

export function applyFireworksConfig(cfg: AllBotConfig): AllBotConfig {
  return fireworksPresetAppliers.applyConfig(cfg);
}
