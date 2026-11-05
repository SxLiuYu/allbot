import {
  applyAgentDefaultModelPrimary,
  type AllBotConfig,
} from "allbot/plugin-sdk/provider-onboard";
import { DEEPINFRA_BASE_URL, DEEPINFRA_DEFAULT_MODEL_REF } from "./provider-models.js";

export { DEEPINFRA_BASE_URL, DEEPINFRA_DEFAULT_MODEL_REF };

export function applyDeepInfraProviderConfig(
  cfg: AllBotConfig,
  modelRef: string = DEEPINFRA_DEFAULT_MODEL_REF,
): AllBotConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[modelRef] = {
    ...models[modelRef],
    alias: models[modelRef]?.alias ?? "DeepInfra",
  };

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
      },
    },
  };
}

export function applyDeepInfraConfig(
  cfg: AllBotConfig,
  modelRef: string = DEEPINFRA_DEFAULT_MODEL_REF,
): AllBotConfig {
  return applyAgentDefaultModelPrimary(applyDeepInfraProviderConfig(cfg, modelRef), modelRef);
}
