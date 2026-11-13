import fs from "fs";
import path from "path";
import { createAttachedChannelResultAdapter } from "allbot/plugin-sdk/channel-send-result";
import { normalizeLowercaseStringOrEmpty } from "allbot/plugin-sdk/text-runtime";
import type { OutboundIdentity } from "../runtime-api.js";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { parseFeishuCommentTarget } from "./comment-target.js";
import { replyComment } from "./drive.js";
import { sendMediaFeishu } from "./media.js";
import {
  createTokenBucket,
  withFeishuSendRateLimit,
  type TokenBucket,
} from "./outbound-rate-limit.js";
import { chunkTextForOutbound, type ChannelOutboundAdapter } from "./outbound-runtime-api.js";
import { sendMarkdownCardFeishu, sendMessageFeishu, sendStructuredCardFeishu } from "./send.js";

function normalizePossibleLocalImagePath(text: string | undefined): string | null {
  const raw = text?.trim();
  if (!raw) {
    return null;
  }

  // Only auto-convert when the message is a pure path-like payload.
  // Avoid converting regular sentences that merely contain a path.
  const hasWhitespace = /\s/.test(raw);
  if (hasWhitespace) {
    return null;
  }

  // Ignore links/data URLs; those should stay in normal mediaUrl/text paths.
  if (/^(https?:\/\/|data:|file:\/\/)/i.test(raw)) {
    return null;
  }

  const ext = normalizeLowercaseStringOrEmpty(path.extname(raw));
  const isImageExt = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".tiff"].includes(
    ext,
  );
  if (!isImageExt) {
    return null;
  }

  if (!path.isAbsolute(raw)) {
    return null;
  }
  if (!fs.existsSync(raw)) {
    return null;
  }

  // Fix race condition: wrap statSync in try-catch to handle file deletion
  // between existsSync and statSync
  try {
    if (!fs.statSync(raw).isFile()) {
      return null;
    }
  } catch {
    // File may have been deleted or became inaccessible between checks
    return null;
  }

  return raw;
}

function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

function resolveReplyToMessageId(params: {
  replyToId?: string | null;
  threadId?: string | number | null;
}): string | undefined {
  const replyToId = params.replyToId?.trim();
  if (replyToId) {
    return replyToId;
  }
  if (params.threadId == null) {
    return undefined;
  }
  const trimmed = String(params.threadId).trim();
  return trimmed || undefined;
}

async function sendCommentThreadReply(params: {
  cfg: Parameters<typeof sendMessageFeishu>[0]["cfg"];
  to: string;
  text: string;
  accountId?: string;
}) {
  const target = parseFeishuCommentTarget(params.to);
  if (!target) {
    return null;
  }
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  const client = createFeishuClient(account);
  const result = await replyComment(client, {
    file_token: target.fileToken,
    file_type: target.fileType,
    comment_id: target.commentId,
    content: params.text,
  });
  return {
    messageId: typeof result.reply_id === "string" ? result.reply_id : "",
    chatId: target.commentId,
    result,
  };
}

async function sendOutboundText(params: {
  cfg: Parameters<typeof sendMessageFeishu>[0]["cfg"];
  to: string;
  text: string;
  replyToMessageId?: string;
  accountId?: string;
}) {
  const { cfg, to, text, accountId, replyToMessageId } = params;
  const commentResult = await sendCommentThreadReply({
    cfg,
    to,
    text,
    accountId,
  });
  if (commentResult) {
    return commentResult;
  }

  const account = resolveFeishuAccount({ cfg, accountId });
  const renderMode = account.config?.renderMode ?? "auto";

  if (renderMode === "card" || (renderMode === "auto" && shouldUseCard(text))) {
    return sendMarkdownCardFeishu({ cfg, to, text, accountId, replyToMessageId });
  }

  return sendMessageFeishu({ cfg, to, text, accountId, replyToMessageId });
}

// Shared token bucket for all Feishu outbound sends.
//
// The adapter-level wrapping below routes every sendText/sendMedia through this
// single bucket. The conservative module defaults (capacity 5 / 1 token/s) are
// NOT Feishu official quotas, so for production we use a generous capacity and a
// fast refill: the bucket is a safety net against accidental tight loops, while
// the per-attempt exponential backoff (in outbound-rate-limit.ts) is what absorbs
// genuine 429/11232 rate-limit responses. Wrapping at the adapter level keeps the
// reply→fallback semantics of sendReplyOrFallbackDirect untouched and avoids
// double-wrapping.
const outboundTokenBucket: TokenBucket = createTokenBucket({
  capacity: 200,
  refillPerSec: 50,
});

function withOutboundRateLimit<T>(fn: () => Promise<T>): Promise<T> {
  return withFeishuSendRateLimit(fn, { tokenBucket: outboundTokenBucket });
}

// Per-call rate-limit wrappers.
//
// The retry boundary lives on each *individual* send (text vs media), not on the
// whole `sendMedia` operation. Earlier the entire `sendMediaImpl` was wrapped, so
// when the text leg succeeded but the media leg hit a 429/11232, the outer retry
// re-ran `sendMediaImpl` from the top — re-sending the already-delivered text.
// Wrapping each leg independently means a media retry only re-attempts the media
// upload, leaving the already-sent text alone (the legs are effectively
// idempotent from the caller's perspective). The reply→fallback semantics inside
// each leg (see send.ts) are untouched.
function sendTextWithRateLimit(
  params: Parameters<typeof sendOutboundText>[0],
): Promise<Awaited<ReturnType<typeof sendOutboundText>>> {
  return withOutboundRateLimit(() => sendOutboundText(params));
}

function sendMediaWithRateLimit(
  params: Parameters<typeof sendMediaFeishu>[0],
): Promise<Awaited<ReturnType<typeof sendMediaFeishu>>> {
  return withOutboundRateLimit(() => sendMediaFeishu(params));
}

async function sendTextImpl(params: {
  cfg: Parameters<typeof sendMessageFeishu>[0]["cfg"];
  to: string;
  text: string;
  accountId?: string | null;
  replyToId?: string | null;
  threadId?: string | number | null;
  mediaLocalRoots?: readonly string[];
  identity?: OutboundIdentity;
}) {
  const { cfg, to, text, accountId, replyToId, threadId, mediaLocalRoots, identity } = params;
  const replyToMessageId = resolveReplyToMessageId({ replyToId, threadId });
  // Scheme A compatibility shim:
  // when upstream accidentally returns a local image path as plain text,
  // auto-upload and send as Feishu image message instead of leaking path text.
  const localImagePath = normalizePossibleLocalImagePath(text);
  if (localImagePath) {
    try {
      // `sendTextImpl` only runs inside the adapter-level sendText wrapper, so
      // this media send is already rate-limited. Wrapping it again would stack
      // two retry loops (inner media retries, then outer whole-send retries).
      return await sendMediaFeishu({
        cfg,
        to,
        mediaUrl: localImagePath,
        accountId: accountId ?? undefined,
        replyToMessageId,
        mediaLocalRoots,
      });
    } catch (err) {
      console.error(`[feishu] local image path auto-send failed:`, err);
      // fall through to plain text as last resort
    }
  }

  if (parseFeishuCommentTarget(to)) {
    return sendOutboundText({
      cfg,
      to,
      text,
      accountId: accountId ?? undefined,
      replyToMessageId,
    });
  }

  const account = resolveFeishuAccount({ cfg, accountId: accountId ?? undefined });
  const renderMode = account.config?.renderMode ?? "auto";
  const useCard = renderMode === "card" || (renderMode === "auto" && shouldUseCard(text));
  if (useCard) {
    const header = identity
      ? {
          title: identity.emoji
            ? `${identity.emoji} ${identity.name ?? ""}`.trim()
            : (identity.name ?? ""),
          template: "blue" as const,
        }
      : undefined;
    return sendStructuredCardFeishu({
      cfg,
      to,
      text,
      replyToMessageId,
      replyInThread: threadId != null && !replyToId,
      accountId: accountId ?? undefined,
      header: header?.title ? header : undefined,
    });
  }
  return sendOutboundText({
    cfg,
    to,
    text,
    accountId: accountId ?? undefined,
    replyToMessageId,
  });
}

async function sendMediaImpl(params: {
  cfg: Parameters<typeof sendMessageFeishu>[0]["cfg"];
  to: string;
  text?: string;
  mediaUrl?: string;
  accountId?: string | null;
  mediaLocalRoots?: readonly string[];
  replyToId?: string | null;
  threadId?: string | number | null;
}) {
  const { cfg, to, text, mediaUrl, accountId, mediaLocalRoots, replyToId, threadId } = params;
  const replyToMessageId = resolveReplyToMessageId({ replyToId, threadId });
  const commentTarget = parseFeishuCommentTarget(to);
  if (commentTarget) {
    const commentText = [text?.trim(), mediaUrl?.trim()].filter(Boolean).join("\n\n");
    return sendTextWithRateLimit({
      cfg,
      to,
      text: commentText || mediaUrl || text || "",
      accountId: accountId ?? undefined,
      replyToMessageId,
    });
  }

  const hasText = Boolean(text?.trim());
  const hasMedia = Boolean(mediaUrl);

  // When only text (or nothing) is provided, send text and return.
  if (hasText && !hasMedia) {
    return sendTextWithRateLimit({
      cfg,
      to,
      text: text ?? "",
      accountId: accountId ?? undefined,
      replyToMessageId,
    });
  }

  // Send text first if provided (no return — media follows).
  // Each leg is independently wrapped by the outbound rate limiter: if the text
  // leg succeeds but the media leg is throttled, only the media upload retries —
  // the already-delivered text is never re-sent.
  if (hasText) {
    await sendTextWithRateLimit({
      cfg,
      to,
      text: text ?? "",
      accountId: accountId ?? undefined,
      replyToMessageId,
    });
  }

  // Upload and send media if URL or local path provided
  if (hasMedia) {
    try {
      return await sendMediaWithRateLimit({
        cfg,
        to,
        mediaUrl,
        accountId: accountId ?? undefined,
        mediaLocalRoots,
        replyToMessageId,
      });
    } catch (err) {
      // Log the error for debugging
      console.error(`[feishu] sendMediaFeishu failed:`, err);
      // Fallback to URL link if upload fails
      return sendTextWithRateLimit({
        cfg,
        to,
        text: `📎 ${mediaUrl}`,
        accountId: accountId ?? undefined,
        replyToMessageId,
      });
    }
  }

  // Fallback when neither text nor media is usable (shouldn't normally happen).
  return sendTextWithRateLimit({
    cfg,
    to,
    text: text ?? "",
    accountId: accountId ?? undefined,
    replyToMessageId,
  });
}

export const feishuOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  ...createAttachedChannelResultAdapter({
    channel: "feishu",
    sendText: (params) =>
      withOutboundRateLimit(() =>
        sendTextImpl({
          cfg: params.cfg,
          to: params.to,
          text: params.text,
          accountId: params.accountId,
          replyToId: params.replyToId,
          threadId: params.threadId,
          mediaLocalRoots: params.mediaLocalRoots,
          identity: params.identity,
        }),
      ),
    // NOTE: `sendMediaImpl` wraps each individual send (text leg / media leg) in
    // the outbound rate limiter itself, so we must NOT wrap the whole impl again
    // here — doing so would retry the already-delivered text leg when only the
    // media leg is throttled. See sendMediaImpl / sendTextWithRateLimit /
    // sendMediaWithRateLimit above.
    sendMedia: (params) =>
      sendMediaImpl({
        cfg: params.cfg,
        to: params.to,
        text: params.text,
        mediaUrl: params.mediaUrl,
        accountId: params.accountId,
        mediaLocalRoots: params.mediaLocalRoots,
        replyToId: params.replyToId,
        threadId: params.threadId,
      }),
  }),
};
