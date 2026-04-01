import type { CommandContext, Context } from "grammy";

import type { GeminiSessionManager } from "../../gemini/session.js";
import type { GeminiProvider } from "../../gemini/provider.js";
import { getSessionKey, getSessionLabel } from "../sessionKey.js";

export function makeClearHandler(
  sessionManager: GeminiSessionManager,
  provider: GeminiProvider,
) {
  return async (ctx: CommandContext<Context>): Promise<void> => {
    const sessionKey = getSessionKey(ctx);

    try {
      await sessionManager.clearSession(provider.config, sessionKey);
      // Ensure the page is ready after navigation
      const page = sessionManager.getPage(sessionKey);
      if (page) await provider.ensureReady(page);
      await ctx.reply("Conversation reset. New session started!");
    } catch {
      await ctx.reply("Could not reset the conversation. Try again shortly.");
    }
  };
}
