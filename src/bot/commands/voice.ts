import type { CommandContext, Context } from "grammy";
import { InputFile } from "grammy";

import type { GeminiSessionManager } from "../../gemini/session.js";
import type { GeminiProvider } from "../../gemini/provider.js";
import { startTyping } from "../middleware/typing.js";

export function makeVoiceHandler(
  sessionManager: GeminiSessionManager,
  provider: GeminiProvider,
) {
  return async (ctx: CommandContext<Context>): Promise<void> => {
    const page = sessionManager.getPage();
    if (!page) {
      await ctx.reply("Nessuna sessione attiva. Scrivi prima qualcosa per avere una risposta da leggere.");
      return;
    }

    const stopTyping = startTyping(ctx);

    try {
      const buf = await provider.downloadLastResponseAudio(page);
      stopTyping();

      if (buf) {
        await ctx.replyWithVoice(new InputFile(buf, "voice.mp3"));
      } else {
        await ctx.reply("Non riesco ad ottenere l'audio. Assicurati che ci sia una risposta recente.");
      }
    } catch {
      stopTyping();
      await ctx.reply("Errore nell'ottenere l'audio. Riprova tra poco.");
    }
  };
}
