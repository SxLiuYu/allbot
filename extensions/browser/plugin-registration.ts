import type {
  AllBotPluginApi,
  AllBotPluginNodeHostCommand,
  AllBotPluginToolContext,
  AllBotPluginToolFactory,
} from "allbot/plugin-sdk/plugin-entry";
import {
  collectBrowserSecurityAuditFindings,
  createBrowserPluginService,
  createBrowserTool,
  handleBrowserGatewayRequest,
  registerBrowserCli,
  runBrowserProxyCommand,
} from "./register.runtime.js";

export const browserPluginReload = { restartPrefixes: ["browser"] };

export const browserPluginNodeHostCommands: AllBotPluginNodeHostCommand[] = [
  {
    command: "browser.proxy",
    cap: "browser",
    handle: runBrowserProxyCommand,
  },
];

export const browserSecurityAuditCollectors = [collectBrowserSecurityAuditFindings];

export function registerBrowserPlugin(api: AllBotPluginApi) {
  api.registerTool(((ctx: AllBotPluginToolContext) =>
    createBrowserTool({
      sandboxBridgeUrl: ctx.browser?.sandboxBridgeUrl,
      allowHostControl: ctx.browser?.allowHostControl,
      agentSessionKey: ctx.sessionKey,
      agentId: ctx.agentId,
    })) as AllBotPluginToolFactory);
  api.registerCli(({ program }) => registerBrowserCli(program), { commands: ["browser"] });
  api.registerGatewayMethod("browser.request", handleBrowserGatewayRequest, {
    scope: "operator.write",
  });
  api.registerService(createBrowserPluginService());
}
