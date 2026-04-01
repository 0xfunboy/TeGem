import type { Context } from "grammy";

/**
 * Returns a stable session key for the current chat context.
 * Private chats → "user_{userId}"
 * Groups/supergroups → "group_{chatId}"
 */
export function getSessionKey(ctx: Context): string {
  const chatType = ctx.chat?.type;
  if (chatType === "private") return `user_${ctx.from!.id}`;
  return `group_${ctx.chat!.id}`;
}
