import type { CommandContext, Context } from "grammy";

import type { GeminiSessionManager } from "../../gemini/session.js";
import { getSessionKey } from "../sessionKey.js";

export function makeStatusHandler(sessionManager: GeminiSessionManager) {
  return async (ctx: CommandContext<Context>): Promise<void> => {
    const sessionKey = getSessionKey(ctx);
    const alive = sessionManager.isAlive();
    const page = sessionManager.getPage(sessionKey);

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
      geminiStatus = `Browser alive — no session for ${sessionKey} yet`;
    }

    await ctx.reply(
      `*TeGem Status*\n\n` +
      `Bot: Online\n` +
      `Session: ${sessionKey}\n` +
      `Gemini: ${geminiStatus}\n` +
      `Active sessions: ${sessionManager.sessionCount()}\n` +
      `Headless: ${process.env.PLAYWRIGHT_HEADLESS === "true" ? "Yes" : "No"}`,
      { parse_mode: "Markdown" },
    );
  };
}
