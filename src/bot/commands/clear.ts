import type { CommandContext, Context } from "grammy";

import type { GeminiSessionManager } from "../../gemini/session.js";
import type { GeminiProvider } from "../../gemini/provider.js";
import type { AppConfig } from "../../config.js";

export function makeClearHandler(
  sessionManager: GeminiSessionManager,
  provider: GeminiProvider,
  config: AppConfig,
) {
  return async (ctx: CommandContext<Context>): Promise<void> => {
    const page = sessionManager.getPage();
    if (page) {
      try {
        await page.goto(provider.config.baseUrl, { waitUntil: "domcontentloaded" });
        await ctx.reply("Conversazione cancellata. Inizia pure con un nuovo messaggio!", { parse_mode: "Markdown" });
      } catch {
        await ctx.reply("Non riesco a resettare la conversazione. Riprova tra poco.");
      }
    } else {
      await ctx.reply("Nessuna sessione attiva. Scrivi qualcosa per iniziare!");
    }
  };
}
