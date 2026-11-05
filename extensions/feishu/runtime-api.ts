// Private runtime barrel for the bundled Feishu extension.
// Keep this barrel thin and generic-only.

export type {
  AllowlistMatch,
  AnyAgentTool,
  BaseProbeResult,
  ChannelGroupContext,
  ChannelMessageActionName,
  ChannelMeta,
  ChannelOutboundAdapter,
  ChannelPlugin,
  HistoryEntry,
  AllBotConfig,
  AllBotPluginApi,
  OutboundIdentity,
  PluginRuntime,
  ReplyPayload,
} from "allbot/plugin-sdk/core";
export type { AllBotConfig as ClawdbotConfig } from "allbot/plugin-sdk/core";
export type { RuntimeEnv } from "allbot/plugin-sdk/runtime";
export type { GroupToolPolicyConfig } from "allbot/plugin-sdk/config-runtime";
export {
  DEFAULT_ACCOUNT_ID,
  buildChannelConfigSchema,
  createActionGate,
  createDedupeCache,
} from "allbot/plugin-sdk/core";
export {
  PAIRING_APPROVED_MESSAGE,
  buildProbeChannelStatusSummary,
  createDefaultChannelRuntimeState,
} from "allbot/plugin-sdk/channel-status";
export { buildAgentMediaPayload } from "allbot/plugin-sdk/agent-media-payload";
export { createChannelPairingController } from "allbot/plugin-sdk/channel-pairing";
export { createReplyPrefixContext } from "allbot/plugin-sdk/channel-reply-pipeline";
export {
  evaluateSupplementalContextVisibility,
  filterSupplementalContextItems,
  resolveChannelContextVisibilityMode,
} from "allbot/plugin-sdk/config-runtime";
export { loadSessionStore, resolveSessionStoreEntry } from "allbot/plugin-sdk/config-runtime";
export { readJsonFileWithFallback } from "allbot/plugin-sdk/json-store";
export { createPersistentDedupe } from "allbot/plugin-sdk/persistent-dedupe";
export { normalizeAgentId } from "allbot/plugin-sdk/routing";
export { chunkTextForOutbound } from "allbot/plugin-sdk/text-chunking";
export {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "allbot/plugin-sdk/webhook-ingress";
export { setFeishuRuntime } from "./src/runtime.js";
