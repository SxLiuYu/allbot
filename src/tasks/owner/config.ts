import type { AllBotConfig } from "../../config/config.js";
import { DEFAULT_OWNER_TASK_MAX_ACTIVE, DEFAULT_OWNER_TASK_MAX_ATTEMPTS } from "./types.js";

export type OwnerTasksConfig = {
  enabled: boolean;
  maxAttempts: number;
  maxActive: number;
};

/**
 * Owner tasks are opt-in. Missing config means "disabled", so a deployment
 * that never touches `tasks` keeps the pre-existing subagent/cron behavior.
 */
export function resolveOwnerTasksConfig(cfg: AllBotConfig | undefined): OwnerTasksConfig {
  const configured = cfg?.tasks;
  const enabled = configured?.enabled === true;
  const maxAttempts =
    typeof configured?.maxAttempts === "number" &&
    Number.isInteger(configured.maxAttempts) &&
    configured.maxAttempts > 0
      ? configured.maxAttempts
      : DEFAULT_OWNER_TASK_MAX_ATTEMPTS;
  const maxActive =
    typeof configured?.maxActive === "number" &&
    Number.isInteger(configured.maxActive) &&
    configured.maxActive > 0
      ? configured.maxActive
      : DEFAULT_OWNER_TASK_MAX_ACTIVE;
  return { enabled, maxAttempts, maxActive };
}

export function ownerTasksEnabled(cfg: AllBotConfig | undefined): boolean {
  return resolveOwnerTasksConfig(cfg).enabled;
}
