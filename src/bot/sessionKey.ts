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

/**
 * Returns a human-readable label for the session (for logging and the store).
 * e.g. "DM funboy", "Group gooners"
 */
export function getSessionLabel(ctx: Context): string {
  const chatType = ctx.chat?.type;
  if (chatType === "private") {
    const name = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ").trim()
      || ctx.from?.username
      || String(ctx.from?.id);
    return `DM ${name}`;
  }
  const title = (ctx.chat as { title?: string })?.title ?? String(ctx.chat?.id);
  return `Group ${title}`;
}
