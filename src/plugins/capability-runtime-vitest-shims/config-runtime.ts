import { resolveActiveTalkProviderConfig } from "../../config/talk.js";
import type { AllBotConfig } from "../../config/types.js";

export { resolveActiveTalkProviderConfig };

export function getRuntimeConfigSnapshot(): AllBotConfig | null {
  return null;
}
