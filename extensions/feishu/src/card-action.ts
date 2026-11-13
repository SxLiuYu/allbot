import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { handleFeishuMessage, type FeishuMessageEvent } from "./bot.js";
import { decodeFeishuCardAction, buildFeishuCardActionTextFallback } from "./card-interaction.js";
import {
  createApprovalCard,
  FEISHU_APPROVAL_CANCEL_ACTION,
  FEISHU_APPROVAL_CONFIRM_ACTION,
  FEISHU_APPROVAL_REQUEST_ACTION,
} from "./card-ux-approval.js";
import { sendCardFeishu, sendMessageFeishu, collapseCardFeishu } from "./send.js";

export type FeishuCardActionEvent = {
  operator: {
    open_id: string;
    user_id: string;
    union_id: string;
  };
  token: string;
  action: {
    value: Record<string, unknown>;
    tag: string;
  };
  /** Id of the message that carried the card, when the surface exposes it. */
  messageId?: string;
  /** "p2p" / "group" as reported by the card envelope, when present. */
  chatType?: "p2p" | "group";
  context: {
    open_id: string;
    user_id: string;
    chat_id: string;
  };
};

const FEISHU_APPROVAL_CARD_TTL_MS = 5 * 60_000;
const FEISHU_CARD_ACTION_TOKEN_TTL_MS = 15 * 60_000;
const processedCardActionTokens = new Map<
  string,
  { status: "inflight" | "completed"; expiresAt: number }
>();

export function resetProcessedFeishuCardActionTokensForTests(): void {
  processedCardActionTokens.clear();
}

function pruneProcessedCardActionTokens(now: number): void {
  for (const [key, entry] of processedCardActionTokens.entries()) {
    if (entry.expiresAt <= now) {
      processedCardActionTokens.delete(key);
    }
  }
}

function beginFeishuCardActionToken(params: {
  token: string;
  accountId: string;
  now?: number;
}): boolean {
  const now = params.now ?? Date.now();
  pruneProcessedCardActionTokens(now);
  const normalizedToken = params.token.trim();
  if (!normalizedToken) {
    return true;
  }
  const key = `${params.accountId}:${normalizedToken}`;
  const existing = processedCardActionTokens.get(key);
  if (existing && existing.expiresAt > now) {
    return false;
  }
  processedCardActionTokens.set(key, {
    status: "inflight",
    expiresAt: now + FEISHU_CARD_ACTION_TOKEN_TTL_MS,
  });
  return true;
}

function completeFeishuCardActionToken(params: {
  token: string;
  accountId: string;
  now?: number;
}): void {
  const now = params.now ?? Date.now();
  const normalizedToken = params.token.trim();
  if (!normalizedToken) {
    return;
  }
  processedCardActionTokens.set(`${params.accountId}:${normalizedToken}`, {
    status: "completed",
    expiresAt: now + FEISHU_CARD_ACTION_TOKEN_TTL_MS,
  });
}

function releaseFeishuCardActionToken(params: { token: string; accountId: string }): void {
  const normalizedToken = params.token.trim();
  if (!normalizedToken) {
    return;
  }
  processedCardActionTokens.delete(`${params.accountId}:${normalizedToken}`);
}

function buildSyntheticMessageEvent(
  event: FeishuCardActionEvent,
  content: string,
  chatType?: "p2p" | "group",
): FeishuMessageEvent {
  return {
    sender: {
      sender_id: {
        open_id: event.operator.open_id,
        user_id: event.operator.user_id,
        union_id: event.operator.union_id,
      },
    },
    message: {
      // Internal idempotency key only. `synthetic: true` keeps it away from
      // reply/reaction targets, which Feishu rejects for ids it never issued.
      message_id: `card-action-${event.token}`,
      chat_id: event.context.chat_id || event.operator.open_id,
      chat_type: chatType ?? event.chatType ?? "p2p",
      message_type: "text",
      content: JSON.stringify({ text: content }),
      synthetic: true,
    },
  };
}

function resolveCallbackTarget(event: FeishuCardActionEvent): string {
  const chatId = event.context.chat_id?.trim();
  if (chatId) {
    return `chat:${chatId}`;
  }
  return `user:${event.operator.open_id}`;
}

/**
 * A card button that carries a short `key=value` selection (e.g. `V4=accept`)
 * does not need an LLM turn: the value *is* the result. Routing it through the
 * agent costs a full model round-trip (seconds) and a slice of the account
 * quota for what is a deterministic bookkeeping step.
 *
 * Handlers registered here run before the agent. Returning a reply string marks
 * the action as handled locally; returning undefined falls through to the agent
 * so buttons that genuinely need reasoning keep working.
 */
/**
 * What a local handler wants to happen after a click.
 *
 * - a plain string replies in the chat as a new message;
 * - `{ collapseCard }` rewrites the card the user just tapped so the buttons
 *   are replaced by the choice, which is what a selection actually means;
 * - `{ text }` next to `collapseCard` sends both.
 */
export type FeishuCardLocalCommandReply =
  | string
  | {
      text?: string;
      /** Text to show in place of the buttons, e.g. "V5 = 收到". */
      collapseCard?: string;
    };

export type FeishuCardLocalCommandHandler = (params: {
  key: string;
  value: string;
  event: FeishuCardActionEvent;
  cfg: ClawdbotConfig;
  accountId?: string;
  runtime?: RuntimeEnv;
}) => Promise<FeishuCardLocalCommandReply | undefined> | FeishuCardLocalCommandReply | undefined;

const localCardCommandHandlers: FeishuCardLocalCommandHandler[] = [];

export function registerFeishuCardLocalCommandHandler(
  handler: FeishuCardLocalCommandHandler,
): void {
  localCardCommandHandlers.push(handler);
}

function resolveCardSelectionLogPath(env: NodeJS.ProcessEnv = process.env): string {
  // Under vitest the state dir falls back to a fixed name instead of a
  // pid-derived one: the temp-path guard rejects path.join(os.tmpdir(), <dynamic>)
  // because a predictable name under a shared temp dir is a symlink target.
  const stateDir =
    env.ALLBOT_STATE_DIR?.trim() ||
    (env.VITEST || env.NODE_ENV === "test"
      ? path.join(os.tmpdir(), "allbot-vitest-state")
      : path.join(os.homedir(), ".allbot"));
  return path.join(stateDir, "feishu", "card-selections.jsonl");
}

/**
 * Default handler: append the selection to a JSONL ledger and acknowledge it.
 * Runs last, so anything registered later can claim the same key first.
 */
const recordCardSelectionHandler: FeishuCardLocalCommandHandler = (params) => {
  const record = {
    ts: new Date().toISOString(),
    key: params.key,
    value: params.value,
    openId: params.event.operator.open_id,
    chatId: params.event.context.chat_id ?? null,
    messageId: params.event.messageId ?? null,
    action: typeof params.event.action.value.a === "string" ? params.event.action.value.a : null,
    accountId: params.accountId ?? null,
  };
  const logPath = resolveCardSelectionLogPath();
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch (err) {
    params.runtime?.error?.(`feishu: failed to record card selection: ${String(err)}`);
  }
  // Collapsing the card the user tapped is the whole point of a selection:
  // posting a second message leaves the buttons there, inviting a second tap.
  return { collapseCard: `${params.key} = ${params.value}` };
};

function resetLocalHandlersToDefaults(): void {
  localCardCommandHandlers.length = 0;
  localCardCommandHandlers.push(recordCardSelectionHandler);
}

export function resetFeishuCardLocalCommandHandlersForTests(): void {
  resetLocalHandlersToDefaults();
}

resetLocalHandlersToDefaults();

/** `KEY=value` where KEY is a short uppercase/digit token. */
const LOCAL_COMMAND_PATTERN = /^([A-Z][A-Z0-9_]{0,31})=(.{1,200})$/;

async function tryRunLocalCardCommand(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  command: string;
  runtime?: RuntimeEnv;
  accountId?: string;
}): Promise<FeishuCardLocalCommandReply | undefined> {
  const match = LOCAL_COMMAND_PATTERN.exec(params.command.trim());
  if (!match) {
    return undefined;
  }
  const [, key, value] = match;
  for (const handler of localCardCommandHandlers) {
    try {
      const reply = await handler({
        key,
        value,
        event: params.event,
        cfg: params.cfg,
        accountId: params.accountId,
        runtime: params.runtime,
      });
      if (reply !== undefined) {
        return reply;
      }
    } catch (err) {
      params.runtime?.error?.(
        `feishu: local card command handler failed for ${key}: ${String(err)}`,
      );
    }
  }
  return undefined;
}

/**
 * Apply whatever a local handler asked for. Card collapse is preferred over a
 * new message: it keeps the answer where the user tapped and removes the
 * buttons. If the card can no longer be rewritten (deleted, too old, card JSON
 * unreadable) fall back to a plain reply so the click is never silent.
 */
async function applyLocalCardReply(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  reply: FeishuCardLocalCommandReply;
  runtime?: RuntimeEnv;
  accountId?: string;
}): Promise<void> {
  const { cfg, event, reply, runtime, accountId } = params;
  const normalized: { text?: string; collapseCard?: string } =
    typeof reply === "string" ? { text: reply } : reply;

  const cardMessageId = event.messageId?.trim();
  if (normalized.collapseCard && cardMessageId) {
    try {
      await collapseCardFeishu({
        cfg,
        messageId: cardMessageId,
        selectionText: normalized.collapseCard,
        accountId,
      });
    } catch (err) {
      runtime?.error?.(`feishu: card collapse failed, falling back to a reply: ${String(err)}`);
      await sendMessageFeishu({
        cfg,
        to: resolveCallbackTarget(event),
        text: `✅ 已记录：${normalized.collapseCard}`,
        accountId,
      });
      return;
    }
  } else if (normalized.collapseCard) {
    // No message id to rewrite (legacy payload) — a plain ack is all we have.
    await sendMessageFeishu({
      cfg,
      to: resolveCallbackTarget(event),
      text: `✅ 已记录：${normalized.collapseCard}`,
      accountId,
    });
  }

  if (normalized.text) {
    await sendMessageFeishu({
      cfg,
      to: resolveCallbackTarget(event),
      text: normalized.text,
      accountId,
    });
  }
}

async function dispatchSyntheticCommand(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  command: string;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  accountId?: string;
  chatType?: "p2p" | "group";
}): Promise<void> {
  await handleFeishuMessage({
    cfg: params.cfg,
    event: buildSyntheticMessageEvent(params.event, params.command, params.chatType),
    botOpenId: params.botOpenId,
    runtime: params.runtime,
    accountId: params.accountId,
  });
}

async function sendInvalidInteractionNotice(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  reason: "malformed" | "stale" | "wrong_user" | "wrong_conversation";
  accountId?: string;
}): Promise<void> {
  const reasonText =
    params.reason === "stale"
      ? "This card action has expired. Open a fresh launcher card and try again."
      : params.reason === "wrong_user"
        ? "This card action belongs to a different user."
        : params.reason === "wrong_conversation"
          ? "This card action belongs to a different conversation."
          : "This card action payload is invalid.";

  await sendMessageFeishu({
    cfg: params.cfg,
    to: resolveCallbackTarget(params.event),
    text: `⚠️ ${reasonText}`,
    accountId: params.accountId,
  });
}

export async function handleFeishuCardAction(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  accountId?: string;
}): Promise<void> {
  const { cfg, event, runtime, accountId } = params;
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  const log = runtime?.log ?? console.log;
  const decoded = decodeFeishuCardAction({ event });
  const claimedToken = beginFeishuCardActionToken({
    token: event.token,
    accountId: account.accountId,
  });
  if (!claimedToken) {
    log(`feishu[${account.accountId}]: skipping duplicate card action token ${event.token}`);
    return;
  }

  try {
    if (decoded.kind === "invalid") {
      log(
        `feishu[${account.accountId}]: rejected card action from ${event.operator.open_id}: ${decoded.reason}`,
      );
      await sendInvalidInteractionNotice({
        cfg,
        event,
        reason: decoded.reason,
        accountId,
      });
      completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
      return;
    }

    if (decoded.kind === "structured") {
      const { envelope } = decoded;
      log(
        `feishu[${account.accountId}]: handling structured card action ${envelope.a} from ${event.operator.open_id}`,
      );

      if (envelope.a === FEISHU_APPROVAL_REQUEST_ACTION) {
        const command = typeof envelope.m?.command === "string" ? envelope.m.command.trim() : "";
        if (!command) {
          await sendInvalidInteractionNotice({
            cfg,
            event,
            reason: "malformed",
            accountId,
          });
          completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
          return;
        }
        const prompt =
          typeof envelope.m?.prompt === "string" && envelope.m.prompt.trim()
            ? envelope.m.prompt
            : `Run \`${command}\` in this Feishu conversation?`;
        await sendCardFeishu({
          cfg,
          to: resolveCallbackTarget(event),
          card: createApprovalCard({
            operatorOpenId: event.operator.open_id,
            chatId: event.context.chat_id || undefined,
            command,
            prompt,
            sessionKey: envelope.c?.s,
            expiresAt: Date.now() + FEISHU_APPROVAL_CARD_TTL_MS,
            chatType: envelope.c?.t ?? event.chatType ?? "p2p",
            confirmLabel: command === "/reset" ? "Reset" : "Confirm",
          }),
          accountId,
        });
        completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
        return;
      }

      if (envelope.a === FEISHU_APPROVAL_CANCEL_ACTION) {
        await sendMessageFeishu({
          cfg,
          to: resolveCallbackTarget(event),
          text: "Cancelled.",
          accountId,
        });
        completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
        return;
      }

      if (envelope.a === FEISHU_APPROVAL_CONFIRM_ACTION || envelope.k === "quick") {
        const command = envelope.q?.trim();
        if (!command) {
          await sendInvalidInteractionNotice({
            cfg,
            event,
            reason: "malformed",
            accountId,
          });
          completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
          return;
        }
        // Deterministic selections (`KEY=value`) are settled locally; only
        // commands that need reasoning fall through to the agent.
        const localReply = await tryRunLocalCardCommand({
          cfg,
          event,
          command,
          runtime,
          accountId,
        });
        if (localReply !== undefined) {
          log(
            `feishu[${account.accountId}]: handled card action locally (${command}) — no agent turn`,
          );
          await applyLocalCardReply({ cfg, event, reply: localReply, runtime, accountId });
          completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
          return;
        }
        await dispatchSyntheticCommand({
          cfg,
          event,
          command,
          botOpenId: params.botOpenId,
          runtime,
          accountId,
          chatType: envelope.c?.t ?? event.chatType ?? "p2p",
        });
        completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
        return;
      }

      await sendInvalidInteractionNotice({
        cfg,
        event,
        reason: "malformed",
        accountId,
      });
      completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
      return;
    }

    const content = buildFeishuCardActionTextFallback(event);

    log(
      `feishu[${account.accountId}]: handling card action from ${event.operator.open_id}: ${content}`,
    );

    await dispatchSyntheticCommand({
      cfg,
      event,
      command: content,
      botOpenId: params.botOpenId,
      runtime,
      accountId,
    });
    completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
  } catch (err) {
    releaseFeishuCardActionToken({ token: event.token, accountId: account.accountId });
    throw err;
  }
}
