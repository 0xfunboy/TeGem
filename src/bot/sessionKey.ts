import type { Context } from "grammy";

/**
 * Returns a stable session key for the current chat/user combination.
 *
 * Private chat → "user_{userId}"
 *   One conversation per user, shared across restarts.
 *
 * Group/supergroup → "group_{chatId}_user_{userId}"
 *   One conversation per user per group, so multiple users can chat
 *   in the same group simultaneously without interfering with each other.
 */
export function getSessionKey(ctx: Context): string {
  const chatType = ctx.chat?.type;
  const userId = ctx.from?.id;

  if (chatType === "private") return `user_${userId}`;
  return `group_${ctx.chat!.id}_user_${userId}`;
}

/**
 * Returns a human-readable label for the session (for logging and the store).
 * e.g. "DM funboy", "Group gooners / funboy"
 */
export function getSessionLabel(ctx: Context): string {
  const chatType = ctx.chat?.type;
  const userName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ").trim()
    || ctx.from?.username
    || String(ctx.from?.id);

  if (chatType === "private") return `DM ${userName}`;

  const groupTitle = (ctx.chat as { title?: string })?.title ?? String(ctx.chat?.id);
  return `${groupTitle} / ${userName}`;
}
