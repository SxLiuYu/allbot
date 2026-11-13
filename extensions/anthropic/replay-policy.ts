import type {
  ProviderReplayPolicy,
  ProviderReplayPolicyContext,
} from "allbot/plugin-sdk/plugin-entry";
import { buildNativeAnthropicReplayPolicyForModel } from "allbot/plugin-sdk/provider-model-shared";

/**
 * Returns the provider-owned replay policy for Anthropic transports.
 */
export function buildAnthropicReplayPolicy(ctx: ProviderReplayPolicyContext): ProviderReplayPolicy {
  return buildNativeAnthropicReplayPolicyForModel(ctx.modelId);
}
