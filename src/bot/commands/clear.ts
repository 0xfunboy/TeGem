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
    if (!page) {
      await ctx.reply("Nessuna sessione attiva. Scrivi qualcosa per iniziare!");
      return;
    }

    try {
      // Navigate to a fresh Gemini conversation
      await page.goto(provider.config.baseUrl, { waitUntil: "domcontentloaded" });
      await provider.ensureReady(page);

      // Silently re-inject the system prompt so the new conversation has context
      await provider.injectSystemPrompt(page, config.systemPrompt);

      await ctx.reply("Conversazione resettata. Il contesto di TeGem è stato reinizializzato — puoi ricominciare!");
    } catch {
      await ctx.reply("Non riesco a resettare la conversazione. Riprova tra poco.");
    }
  };
}
