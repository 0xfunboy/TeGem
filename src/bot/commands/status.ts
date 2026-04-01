import type { CommandContext, Context } from "grammy";

import type { GeminiSessionManager } from "../../gemini/session.js";
import { getSessionKey } from "../sessionKey.js";

export function makeStatusHandler(sessionManager: GeminiSessionManager) {
  return async (ctx: CommandContext<Context>): Promise<void> => {
    const sessionKey = getSessionKey(ctx);
    const alive = sessionManager.isAlive();
    const page = sessionManager.getPage(sessionKey);
    const stored = sessionManager.getStoredSession(sessionKey);

    let geminiStatus = "Not connected";
    if (alive && page) {
      try {
        geminiStatus = page.isClosed()
          ? "Page closed"
          : `Connected (${page.url().split("?")[0]})`;
      } catch {
        geminiStatus = "Session error";
      }
    } else if (alive) {
      geminiStatus = stored
        ? `Stored — will reconnect to ${stored.conversationId}`
        : "Browser alive — no tab yet";
    }

    const convLine = stored
      ? `Conversation: \`${stored.conversationId}\` (${stored.label})`
      : "Conversation: not yet assigned";

    await ctx.reply(
      `*TeGem Status*\n\n` +
      `Session key: \`${sessionKey}\`\n` +
      `${convLine}\n` +
      `Gemini: ${geminiStatus}\n` +
      `Active tabs: ${sessionManager.sessionCount()}\n` +
      `Headless: ${process.env.PLAYWRIGHT_HEADLESS === "true" ? "Yes" : "No"}`,
      { parse_mode: "Markdown" },
    );
  };
}
