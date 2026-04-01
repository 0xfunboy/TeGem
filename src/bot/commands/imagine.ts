import type { CommandContext, Context } from "grammy";
import { InputFile } from "grammy";

import type { GeminiSessionManager } from "../../gemini/session.js";
import type { GeminiProvider } from "../../gemini/provider.js";
import type { AppConfig } from "../../config.js";
import { startTyping } from "../middleware/typing.js";
import { GeminiNotReadyError } from "../../gemini/errors.js";

export function makeImagineHandler(
  sessionManager: GeminiSessionManager,
  provider: GeminiProvider,
  config: AppConfig,
) {
  return async (ctx: CommandContext<Context>): Promise<void> => {
    const args = ctx.match?.trim();
    if (!args) {
      await ctx.reply(
        "Uso: /imagine <descrizione>\n\nEsempio: `/imagine un tramonto sul mare con colori vividi`",
        { parse_mode: "Markdown" },
      );
      return;
    }

    const stopTyping = startTyping(ctx);
    const profilePath = sessionManager.resolveProfilePath(config.profileDir);

    try {
      const session = await sessionManager.getOrCreate(provider.config, profilePath);
      const page = session.page;

      await provider.ensureReady(page);
      await provider.ensureConversationNotFull(page);

      const baseline = await provider.snapshotConversation(page);
      const prompt = `genera un'immagine: ${args}`;
      baseline.prompt = prompt;

      await provider.sendPrompt(page, prompt);

      // Consume the stream fully
      let finalText = "";
      let images: Array<{ src: string; alt?: string }> = [];

      const gen = provider.streamResponse(page, baseline);
      let next = await gen.next();
      while (!next.done) {
        next = await gen.next();
      }

      if (next.value) {
        finalText = next.value.text;
        images = next.value.images;
      }

      // If DOM-based image capture returned nothing, try the screenshot fallback
      if (images.length === 0) {
        images = await provider.screenshotLastResponse(page);
      }

      stopTyping();

      if (images.length > 0) {
        for (const img of images) {
          const base64 = img.src.startsWith("data:") ? img.src.split(",")[1] : null;
          if (base64) {
            const buffer = Buffer.from(base64, "base64");
            await ctx.replyWithPhoto(new InputFile(buffer, "image.png"), {
              caption: finalText.trim() || img.alt || args,
            });
          } else {
            await ctx.replyWithPhoto(img.src, { caption: finalText.trim() || img.alt || args });
          }
        }
      } else if (finalText.trim()) {
        // Gemini replied with text only (might have declined image generation)
        await ctx.reply(finalText);
      } else {
        await ctx.reply("Gemini non ha generato immagini. Prova con una descrizione diversa.");
      }
    } catch (err) {
      stopTyping();
      if (err instanceof GeminiNotReadyError) {
        await ctx.reply("Gemini non è pronto. Usa /status per verificare la connessione.");
      } else {
        const message = err instanceof Error ? err.message : String(err);
        await ctx.reply(`Errore: ${message}`);
      }
    }
  };
}
