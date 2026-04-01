import type { CommandContext, Context } from "grammy";

import type { GeminiSessionManager } from "../../gemini/session.js";

export function makeStatusHandler(sessionManager: GeminiSessionManager) {
  return async (ctx: CommandContext<Context>): Promise<void> => {
    const alive = sessionManager.isAlive();
    const page = sessionManager.getPage();

    let geminiStatus = "Non connesso";
    if (alive && page) {
      try {
        const isReady = !page.isClosed();
        geminiStatus = isReady ? `Connesso (${page.url().split("?")[0]})` : "Pagina chiusa";
      } catch {
        geminiStatus = "Errore di sessione";
      }
    }

    await ctx.reply(
      `*Stato TeGem*\n\n` +
      `Bot: Online\n` +
      `Gemini: ${geminiStatus}\n` +
      `Headless: ${process.env.PLAYWRIGHT_HEADLESS === "true" ? "Sì" : "No"}`,
      { parse_mode: "Markdown" },
    );
  };
}
