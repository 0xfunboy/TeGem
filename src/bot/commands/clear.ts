import type { CommandContext, Context } from "grammy";

import type { GeminiSessionManager } from "../../gemini/session.js";
import type { GeminiProvider } from "../../gemini/provider.js";
import { getSessionKey } from "../sessionKey.js";

export function makeClearHandler(
  sessionManager: GeminiSessionManager,
  provider: GeminiProvider,
) {
  return async (ctx: CommandContext<Context>): Promise<void> => {
    const sessionKey = getSessionKey(ctx);
    const page = sessionManager.getPage(sessionKey);
    if (!page) {
      await ctx.reply("No active session. Write something to start!");
      return;
    }

    try {
      await page.goto(provider.config.baseUrl, { waitUntil: "domcontentloaded" });
      await provider.ensureReady(page);
      await ctx.reply("Conversation reset. You can start fresh!");
    } catch {
      await ctx.reply("Could not reset the conversation. Try again shortly.");
    }
  };
}
