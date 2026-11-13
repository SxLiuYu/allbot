export type TasksConfig = {
  /**
   * Enables the owner task lifecycle (Router session -> worker -> review).
   * Default: false. When disabled, subagent/cron behavior is unchanged.
   */
  enabled?: boolean;
  /** Maximum worker attempts before a rejected task is marked failed. Default: 3. */
  maxAttempts?: number;
  /** Maximum number of in_progress tasks per owner. Default: 8. */
  maxActive?: number;
  /** Optional cross-device sync. Disabled unless explicitly enabled; token is read only from tokenEnv. */
  sync?: {
    enabled?: boolean;
    baseUrl?: string;
    tokenEnv?: string;
    deviceId?: string;
  };
};
