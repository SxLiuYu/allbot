export type FeishuActivitySignal = {
  senderOpenId: string;
  chatId?: string;
  chatType?: string;
  at: number;
};

const ACTIVITY_BRIDGE_KEY = Symbol.for("allbot.cognitive.feishuActivityBridge");

type ActivityBridge = {
  emit: (signal: FeishuActivitySignal) => void;
};

type GlobalWithBridge = typeof globalThis & { [ACTIVITY_BRIDGE_KEY]?: ActivityBridge };

/**
 * Fires on a real inbound Feishu message. The gateway-side
 * FeishuActivitySource installs the bridge when the cognitive scheduler starts.
 * This module intentionally shares only a global symbol, not an import path,
 * so the extension does not depend on gateway internals.
 */
export function emitFeishuActivitySignal(signal: FeishuActivitySignal): void {
  (globalThis as GlobalWithBridge)[ACTIVITY_BRIDGE_KEY]?.emit(signal);
}
