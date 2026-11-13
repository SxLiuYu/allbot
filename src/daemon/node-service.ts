import {
  NODE_SERVICE_KIND,
  NODE_SERVICE_MARKER,
  NODE_WINDOWS_TASK_SCRIPT_NAME,
  resolveNodeLaunchAgentLabel,
  resolveNodeSystemdServiceName,
  resolveNodeWindowsTaskName,
} from "./constants.js";
import {
  tryResolveGatewayService,
  type GatewayService,
  type GatewayServiceInstallArgs,
} from "./service.js";

function withNodeServiceEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ...env,
    ALLBOT_LAUNCHD_LABEL: resolveNodeLaunchAgentLabel(),
    ALLBOT_SYSTEMD_UNIT: resolveNodeSystemdServiceName(),
    ALLBOT_WINDOWS_TASK_NAME: resolveNodeWindowsTaskName(),
    ALLBOT_TASK_SCRIPT_NAME: NODE_WINDOWS_TASK_SCRIPT_NAME,
    ALLBOT_LOG_PREFIX: "node",
    ALLBOT_SERVICE_MARKER: NODE_SERVICE_MARKER,
    ALLBOT_SERVICE_KIND: NODE_SERVICE_KIND,
  };
}

function withNodeInstallEnv(args: GatewayServiceInstallArgs): GatewayServiceInstallArgs {
  return {
    ...args,
    env: withNodeServiceEnv(args.env),
    environment: {
      ...args.environment,
      ALLBOT_LAUNCHD_LABEL: resolveNodeLaunchAgentLabel(),
      ALLBOT_SYSTEMD_UNIT: resolveNodeSystemdServiceName(),
      ALLBOT_WINDOWS_TASK_NAME: resolveNodeWindowsTaskName(),
      ALLBOT_TASK_SCRIPT_NAME: NODE_WINDOWS_TASK_SCRIPT_NAME,
      ALLBOT_LOG_PREFIX: "node",
      ALLBOT_SERVICE_MARKER: NODE_SERVICE_MARKER,
      ALLBOT_SERVICE_KIND: NODE_SERVICE_KIND,
    },
  };
}

export function resolveNodeService(): GatewayService | null {
  const base = tryResolveGatewayService();
  if (!base) {
    return null;
  }
  return {
    ...base,
    stage: async (args) => {
      return base.stage(withNodeInstallEnv(args));
    },
    install: async (args) => {
      return base.install(withNodeInstallEnv(args));
    },
    uninstall: async (args) => {
      return base.uninstall({ ...args, env: withNodeServiceEnv(args.env) });
    },
    stop: async (args) => {
      return base.stop({ ...args, env: withNodeServiceEnv(args.env ?? {}) });
    },
    restart: async (args) => {
      return base.restart({ ...args, env: withNodeServiceEnv(args.env ?? {}) });
    },
    isLoaded: async (args) => {
      return base.isLoaded({ env: withNodeServiceEnv(args.env ?? {}) });
    },
    readCommand: (env) => base.readCommand(withNodeServiceEnv(env)),
    readRuntime: (env) => base.readRuntime(withNodeServiceEnv(env)),
  };
}
