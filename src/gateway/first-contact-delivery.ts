import type { AllBotConfig } from "../config/config.js";
import type { DeliverOutboundPayloadsParams } from "../infra/outbound/deliver.js";
import type { OutboundChannel } from "../infra/outbound/targets.js";

export type FirstContactRecipient = {
  channel: string;
  to: string;
  accountId?: string;
};

/**
 * Build the direct-delivery params for the opening greeting.
 *
 * The greeting is at-most-once: `firstContactAt` is the only record of it. A
 * write-ahead queue entry left behind by a crash would be replayed by
 * `recoverPendingDeliveries` on the next boot, after the marker was already
 * saved, with no scheduler gate to stop it. Skipping the queue means a crash
 * can only lose the greeting, never duplicate it.
 *
 * Kept as a pure builder (no import of deliver.js) so the gateway can keep its
 * dynamic, lazy import of the outbound module while this stays unit-testable.
 */
export function createFirstContactDeliveryParams(
  cfg: AllBotConfig,
  recipient: FirstContactRecipient,
  content: string,
): DeliverOutboundPayloadsParams {
  return {
    cfg,
    channel: recipient.channel as Exclude<OutboundChannel, "none">,
    to: recipient.to,
    ...(recipient.accountId ? { accountId: recipient.accountId } : {}),
    payloads: [{ text: content }],
    skipQueue: true,
  };
}
