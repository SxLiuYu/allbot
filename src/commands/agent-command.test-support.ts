import path from "node:path";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import type { AllBotConfig } from "../config/config.js";

type AgentDefaultConfig = NonNullable<NonNullable<AllBotConfig["agents"]>["defaults"]>;
type LoadConfigMock = {
  mockReturnValue(value: AllBotConfig): unknown;
};

export async function withAgentCommandTempHome<T>(
  prefix: string,
  fn: (home: string) => Promise<T>,
): Promise<T> {
  return withTempHomeBase(fn, { prefix });
}

export function mockAgentCommandConfig(
  configSpy: LoadConfigMock,
  home: string,
  storePath: string,
  agentOverrides?: Partial<AgentDefaultConfig>,
): AllBotConfig {
  const cfg = {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        models: { "anthropic/claude-opus-4-6": {} },
        workspace: path.join(home, "allbot"),
        ...agentOverrides,
      },
    },
    session: { store: storePath, mainKey: "main" },
  } as AllBotConfig;
  configSpy.mockReturnValue(cfg);
  return cfg;
}

export function createDefaultAgentCommandResult() {
  return {
    payloads: [{ text: "ok" }],
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  };
}
