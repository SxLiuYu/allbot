import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeEnv } from "../../../test/helpers/plugins/runtime-env.js";
import type { RuntimeEnv } from "../runtime-api.js";
import "./lifecycle.test-support.js";
import { resetProcessedFeishuCardActionTokensForTests } from "./card-action.js";
import { resetFeishuCardLocalCommandHandlersForTests } from "./card-action.js";
import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";
import { getFeishuLifecycleTestMocks } from "./lifecycle.test-support.js";
import {
  createFeishuLifecycleConfig,
  createFeishuLifecycleReplyDispatcher,
  createResolvedFeishuLifecycleAccount,
  expectFeishuReplyDispatcherSentFinalReplyOnce,
  expectFeishuReplyPipelineDedupedAcrossReplay,
  expectFeishuReplyPipelineDedupedAfterPostSendFailure,
  installFeishuLifecycleReplyRuntime,
  mockFeishuReplyOnceDispatch,
  restoreFeishuLifecycleStateDir,
  setFeishuLifecycleStateDir,
  setupFeishuLifecycleHandler,
} from "./test-support/lifecycle-test-support.js";

const {
  createEventDispatcherMock,
  collapseCardFeishuMock,
  createFeishuReplyDispatcherMock,
  dispatchReplyFromConfigMock,
  finalizeInboundContextMock,
  resolveAgentRouteMock,
  resolveBoundConversationMock,
  sendCardFeishuMock,
  sendMessageFeishuMock,
  touchBindingMock,
  withReplyDispatcherMock,
} = getFeishuLifecycleTestMocks();

let _handlers: Record<string, (data: unknown) => Promise<void>> = {};
let lastRuntime: RuntimeEnv | null = null;
const originalStateDir = process.env.ALLBOT_STATE_DIR;
const lifecycleConfig = createFeishuLifecycleConfig({
  accountId: "acct-card",
  appId: "cli_test",
  appSecret: "secret_test",
  channelConfig: {
    dmPolicy: "open",
  },
  accountConfig: {
    dmPolicy: "open",
  },
});

const lifecycleAccount = createResolvedFeishuLifecycleAccount({
  accountId: "acct-card",
  appId: "cli_test",
  appSecret: "secret_test",
  config: {
    dmPolicy: "open",
  },
});

function createCardActionEvent(params: {
  token: string;
  action: string;
  command: string;
  chatId?: string;
  chatType?: "group" | "p2p";
  messageId?: string;
}) {
  const openId = "ou_user1";
  const chatId = params.chatId ?? "p2p:ou_user1";
  const chatType = params.chatType ?? "p2p";
  return {
    operator: {
      open_id: openId,
      user_id: "user_1",
      union_id: "union_1",
    },
    token: params.token,
    action: {
      tag: "button",
      value: createFeishuCardInteractionEnvelope({
        k: "quick",
        a: params.action,
        q: params.command,
        c: {
          u: openId,
          h: chatId,
          t: chatType,
          e: Date.now() + 60_000,
        },
      }),
    },
    // Real v2 click payloads carry the card id under `context.open_message_id`;
    // the parser reads it from there, so mirror that shape when a test needs
    // the card the user tapped.
    ...(params.messageId
      ? { context: { open_message_id: params.messageId, open_chat_id: chatId } }
      : {
          context: {
            open_id: openId,
            user_id: "user_1",
            chat_id: chatId,
          },
        }),
  };
}

async function setupLifecycleMonitor() {
  lastRuntime = createRuntimeEnv();
  return setupFeishuLifecycleHandler({
    createEventDispatcherMock,
    onRegister: (registered) => {
      _handlers = registered;
    },
    runtime: lastRuntime!,
    cfg: lifecycleConfig,
    account: lifecycleAccount,
    handlerKey: "card.action.trigger",
    missingHandlerMessage: "missing card.action.trigger handler",
  });
}

describe("Feishu card-action lifecycle", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    _handlers = {};
    lastRuntime = null;
    resetProcessedFeishuCardActionTokensForTests();
    resetFeishuCardLocalCommandHandlersForTests();
    setFeishuLifecycleStateDir("allbot-feishu-card-action");

    createFeishuReplyDispatcherMock.mockReturnValue(createFeishuLifecycleReplyDispatcher());

    resolveBoundConversationMock.mockImplementation(() => ({
      bindingId: "binding-card",
      targetSessionKey: "agent:bound-agent:feishu:direct:ou_user1",
    }));

    resolveAgentRouteMock.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "acct-card",
      sessionKey: "agent:main:feishu:direct:ou_user1",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
    });

    mockFeishuReplyOnceDispatch({
      dispatchReplyFromConfigMock,
      replyText: "card action reply once",
    });

    withReplyDispatcherMock.mockImplementation(async ({ run }) => await run());

    installFeishuLifecycleReplyRuntime({
      resolveAgentRouteMock,
      finalizeInboundContextMock,
      dispatchReplyFromConfigMock,
      withReplyDispatcherMock,
      storePath: "/tmp/feishu-card-action-sessions.json",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetProcessedFeishuCardActionTokensForTests();
    restoreFeishuLifecycleStateDir(originalStateDir);
  });

  it("routes one reply across duplicate callback delivery", async () => {
    const onCardAction = await setupLifecycleMonitor();
    const event = createCardActionEvent({
      token: "tok-card-once",
      action: "feishu.quick_actions.help",
      command: "/help",
    });

    await expectFeishuReplyPipelineDedupedAcrossReplay({
      handler: onCardAction,
      event,
      dispatchReplyFromConfigMock,
      createFeishuReplyDispatcherMock,
    });

    expect(lastRuntime?.error).not.toHaveBeenCalled();
    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledTimes(1);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-card",
        chatId: "p2p:ou_user1",
        // Synthetic card-action events must NOT reply to their internal id:
        // Feishu rejects it with 99992354 ("not a valid {open_message_id}").
        replyToMessageId: undefined,
      }),
    );
    expect(finalizeInboundContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        AccountId: "acct-card",
        SessionKey: "agent:bound-agent:feishu:direct:ou_user1",
        MessageSid: "card-action-tok-card-once",
      }),
    );
    expect(touchBindingMock).toHaveBeenCalledWith("binding-card");

    expectFeishuReplyDispatcherSentFinalReplyOnce({ createFeishuReplyDispatcherMock });
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
  });

  it("does not duplicate delivery when retrying after a post-send failure", async () => {
    const onCardAction = await setupLifecycleMonitor();
    const event = createCardActionEvent({
      token: "tok-card-retry",
      action: "feishu.quick_actions.help",
      command: "/help",
    });

    dispatchReplyFromConfigMock.mockImplementationOnce(async ({ dispatcher }) => {
      await dispatcher.sendFinalReply({ text: "card action reply once" });
      throw new Error("post-send failure");
    });

    await expectFeishuReplyPipelineDedupedAfterPostSendFailure({
      handler: onCardAction,
      event,
      dispatchReplyFromConfigMock,
      runtimeErrorMock: lastRuntime?.error as ReturnType<typeof vi.fn>,
    });

    expect(lastRuntime?.error).toHaveBeenCalledTimes(1);
    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
    expectFeishuReplyDispatcherSentFinalReplyOnce({ createFeishuReplyDispatcherMock });
  });

  // Feishu's `card.action.trigger` v2 surface nests the ids under `context` as
  // `open_chat_id` / `open_message_id` and omits `context.open_id` /
  // `context.user_id` entirely. The parser used to reject that shape as
  // malformed, so every real button click was dropped (2026-11-10 logs).
  it("handles the v2 card.action.trigger payload shape", async () => {
    const onCardAction = await setupLifecycleMonitor();
    const openId = "ou_user1";
    const event = {
      operator: {
        open_id: openId,
        user_id: "user_1",
        union_id: "union_1",
      },
      token: "tok-card-v2",
      action: {
        tag: "button",
        value: createFeishuCardInteractionEnvelope({
          k: "quick",
          a: "feishu.quick_actions.help",
          q: "/help",
          c: {
            u: openId,
            h: "oc_chat_v2",
            t: "p2p",
            e: Date.now() + 60_000,
          },
        }),
      },
      context: {
        open_message_id: "om_card_v2",
        open_chat_id: "oc_chat_v2",
      },
    };

    await onCardAction(event);
    await vi.waitFor(() => {
      expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
    });

    expect(lastRuntime?.error).not.toHaveBeenCalled();
    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-card",
        chatId: "oc_chat_v2",
      }),
    );
  });

  // `KEY=value` selections are deterministic: the click *is* the answer. They
  // must be settled locally instead of costing a full model round-trip, and the
  // card the user tapped should be rewritten in place rather than followed by a
  // second message that leaves the buttons sitting there.
  it("answers a KEY=value selection by collapsing the card in place", async () => {
    const onCardAction = await setupLifecycleMonitor();
    const event = createCardActionEvent({
      token: "tok-card-local",
      action: "verify.pick",
      command: "V4=accept",
      messageId: "om_card_local",
    });

    await onCardAction(event);
    await vi.waitFor(() => {
      expect(collapseCardFeishuMock).toHaveBeenCalledTimes(1);
    });

    expect(collapseCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "om_card_local",
        selectionText: "V4 = accept",
      }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(lastRuntime?.error).not.toHaveBeenCalled();
    expect(dispatchReplyFromConfigMock).not.toHaveBeenCalled();

    const ledger = path.join(
      process.env.ALLBOT_STATE_DIR as string,
      "feishu",
      "card-selections.jsonl",
    );
    const lines = fs.readFileSync(ledger, "utf8").trim().split("\n");
    const record = JSON.parse(lines[lines.length - 1]);
    expect(record).toMatchObject({ key: "V4", value: "accept", openId: "ou_user1" });
  });

  it("falls back to a chat reply when the card cannot be rewritten", async () => {
    const onCardAction = await setupLifecycleMonitor();
    collapseCardFeishuMock.mockRejectedValueOnce(new Error("card gone"));
    const event = createCardActionEvent({
      token: "tok-card-fallback",
      action: "verify.pick",
      command: "V4=accept",
      messageId: "om_card_gone",
    });

    await onCardAction(event);
    await vi.waitFor(() => {
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    });

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("V4 = accept") }),
    );
    expect(lastRuntime?.error).toHaveBeenCalledTimes(1);
  });

  it("still routes non selection commands to the agent", async () => {
    const onCardAction = await setupLifecycleMonitor();
    const event = createCardActionEvent({
      token: "tok-card-agent",
      action: "feishu.quick_actions.help",
      command: "/help",
    });

    await onCardAction(event);
    await vi.waitFor(() => {
      expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
    });

    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });
});
