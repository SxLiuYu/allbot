export type McpLoopbackRuntime = {
  port: number;
  token: string;
};

let activeRuntime: McpLoopbackRuntime | undefined;

export function getActiveMcpLoopbackRuntime(): McpLoopbackRuntime | undefined {
  return activeRuntime ? { ...activeRuntime } : undefined;
}

export function setActiveMcpLoopbackRuntime(runtime: McpLoopbackRuntime): void {
  activeRuntime = { ...runtime };
}

export function clearActiveMcpLoopbackRuntime(token: string): void {
  if (activeRuntime?.token === token) {
    activeRuntime = undefined;
  }
}

export function createMcpLoopbackServerConfig(port: number) {
  return {
    mcpServers: {
      allbot: {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: {
          Authorization: "Bearer ${ALLBOT_MCP_TOKEN}",
          "x-session-key": "${ALLBOT_MCP_SESSION_KEY}",
          "x-allbot-agent-id": "${ALLBOT_MCP_AGENT_ID}",
          "x-allbot-account-id": "${ALLBOT_MCP_ACCOUNT_ID}",
          "x-allbot-message-channel": "${ALLBOT_MCP_MESSAGE_CHANNEL}",
        },
      },
    },
  };
}
