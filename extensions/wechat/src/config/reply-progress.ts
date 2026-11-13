import type { AllBotConfig } from "allbot/plugin-sdk/core";

type WeixinChannelConfig = {
  replyProgressMessages?: boolean;
};

export function resolveReplyProgressMessagesEnabled(cfg: AllBotConfig): boolean {
  const section = cfg.channels?.["wechat"] as WeixinChannelConfig | undefined;
  return section?.replyProgressMessages !== false;
}
