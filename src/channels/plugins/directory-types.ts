import type { AllBotConfig } from "../../config/types.js";

export type DirectoryConfigParams = {
  cfg: AllBotConfig;
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
};
