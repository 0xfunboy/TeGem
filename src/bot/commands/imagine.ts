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
      await ctx.reply("Uso: /imagine <descrizione>\n\nEsempio: `/imagine un tramonto sul mare con colori vividi`", {
        parse_mode: "Markdown",
      });
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
      baseline.prompt = `genera un'immagine: ${args}`;

      await provider.sendPrompt(page, `genera un'immagine: ${args}`);

      let finalText = "";
      let images: Array<{ src: string; alt?: string }> = [];

      const stream = provider.streamResponse(page, baseline);
      let result = await stream.next();
      while (!result.done) {
        result = await stream.next();
      }

      if (result.done && result.value) {
        finalText = result.value.text;
        images = result.value.images;
      }

      stopTyping();

      if (images.length > 0) {
        for (const img of images) {
          if (img.src.startsWith("data:")) {
            const base64 = img.src.split(",")[1];
            const buffer = Buffer.from(base64, "base64");
            await ctx.replyWithPhoto(new InputFile(buffer, "image.png"), {
              caption: img.alt || args,
            });
          } else {
            await ctx.replyWithPhoto(img.src, { caption: img.alt || args });
          }
        }
      } else if (finalText) {
        await ctx.reply(finalText);
      } else {
        await ctx.reply("Gemini non ha generato immagini. Prova con una descrizione diversa.");
      }
    } catch (err) {
      stopTyping();
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof GeminiNotReadyError) {
        await ctx.reply("Gemini non è pronto. Usa prima /status per verificare la connessione.");
      } else {
        await ctx.reply(`Errore nella generazione dell'immagine: ${message}`);
      }
    }
  };
}
