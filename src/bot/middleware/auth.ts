import type { Context, NextFunction } from "grammy";

import type { AppConfig } from "../../config.js";

const UNAUTHORIZED_MESSAGE =
  "Utente o gruppo non abilitato. Contatta @funboynft per richiedere l'autorizzazione.";

export function createAuthMiddleware(config: AppConfig) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const chatType = ctx.chat?.type;

    if (chatType === "private") {
      if (config.allowedUsers.length > 0) {
        const userId = ctx.from?.id;
        if (!userId || !config.allowedUsers.includes(userId)) {
          await ctx.reply?.(UNAUTHORIZED_MESSAGE);
          return;
        }
      }
    } else if (chatType === "group" || chatType === "supergroup") {
      if (config.allowedGroups.length > 0) {
        const chatId = ctx.chat?.id;
        if (!chatId || !config.allowedGroups.includes(chatId)) {
          // Silent drop in groups to avoid spam
          return;
        }
      }
    }

    await next();
  };
}
