export const ALLBOT_CLI_ENV_VAR = "ALLBOT_CLI";
export const ALLBOT_CLI_ENV_VALUE = "1";

export function markAllBotExecEnv<T extends Record<string, string | undefined>>(env: T): T {
  return {
    ...env,
    [ALLBOT_CLI_ENV_VAR]: ALLBOT_CLI_ENV_VALUE,
  };
}

export function ensureAllBotExecMarkerOnProcess(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  env[ALLBOT_CLI_ENV_VAR] = ALLBOT_CLI_ENV_VALUE;
  return env;
}
