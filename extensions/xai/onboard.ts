import {
  createDefaultModelsPresetAppliers,
  type AllBotConfig,
} from "@allbot/plugin-sdk/provider-onboard";
import { XAI_BASE_URL, XAI_DEFAULT_MODEL_ID } from "./model-definitions.js";
import { buildXaiCatalogModels } from "./model-definitions.js";

export const XAI_DEFAULT_MODEL_REF = `xai/${XAI_DEFAULT_MODEL_ID}`;

const xaiPresetAppliers = createDefaultModelsPresetAppliers<
  ["openai-completions" | "openai-responses"]
>({
  primaryModelRef: XAI_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: AllBotConfig, api) => ({
    providerId: "xai",
    api,
    baseUrl: XAI_BASE_URL,
    defaultModels: buildXaiCatalogModels(),
    defaultModelId: XAI_DEFAULT_MODEL_ID,
    aliases: [{ modelRef: XAI_DEFAULT_MODEL_REF, alias: "Grok" }],
  }),
});

export function applyXaiProviderConfig(cfg: AllBotConfig): AllBotConfig {
  return xaiPresetAppliers.applyProviderConfig(cfg, "openai-responses");
}

export function applyXaiResponsesApiConfig(cfg: AllBotConfig): AllBotConfig {
  return xaiPresetAppliers.applyProviderConfig(cfg, "openai-responses");
}

export function applyXaiConfig(cfg: AllBotConfig): AllBotConfig {
  return xaiPresetAppliers.applyConfig(cfg, "openai-responses");
}
