import type { Context, NextFunction } from "grammy";

import type { AppConfig } from "../../config.js";

const UNAUTHORIZED_MESSAGE =
  "User or group not authorized. Contact @funboynft to request access.";

export function createAuthMiddleware(config: AppConfig) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const chatType = ctx.chat?.type;

    if (chatType === "private") {
      // Deny-by-default: if no allowlist is configured, reject everyone.
      // This prevents accidental open access if .env is reset or misconfigured.
      const userId = ctx.from?.id;
      if (!userId || config.allowedUsers.length === 0 || !config.allowedUsers.includes(userId)) {
        await ctx.reply?.(UNAUTHORIZED_MESSAGE);
        return;
      }
    } else if (chatType === "group" || chatType === "supergroup") {
      const chatId = ctx.chat?.id;
      if (!chatId || config.allowedGroups.length === 0 || !config.allowedGroups.includes(chatId)) {
        return; // silent drop in groups
      }
    }

    await next();
  };
}
