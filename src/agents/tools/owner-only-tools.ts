export const ALLBOT_OWNER_ONLY_CORE_TOOL_NAMES = [
  "cron",
  "gateway",
  "mcp_config",
  "nodes",
] as const;

const ALLBOT_OWNER_ONLY_CORE_TOOL_NAME_SET: ReadonlySet<string> = new Set(
  ALLBOT_OWNER_ONLY_CORE_TOOL_NAMES,
);

export function isAllBotOwnerOnlyCoreToolName(toolName: string): boolean {
  return ALLBOT_OWNER_ONLY_CORE_TOOL_NAME_SET.has(toolName);
}
