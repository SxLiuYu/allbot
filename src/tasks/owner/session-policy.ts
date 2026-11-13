import { deriveSessionChatTypeFromKey } from "../../sessions/session-chat-type-shared.js";
import { getSubagentDepth, isCronSessionKey } from "../../sessions/session-key-utils.js";

/**
 * Owner-task write tools are available only in the owner's Router session.
 * Worker, cron and group sessions must not accept/reject/cancel on behalf of
 * the user.
 */
export function canRegisterOwnerTaskWriteTools(sessionKey: string | undefined): boolean {
  const chatType = deriveSessionChatTypeFromKey(sessionKey);
  return (
    getSubagentDepth(sessionKey) === 0 &&
    !isCronSessionKey(sessionKey) &&
    chatType !== "group" &&
    chatType !== "channel"
  );
}
