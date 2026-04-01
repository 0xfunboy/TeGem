import type { CommandContext, Context } from "grammy";
import { InputFile } from "grammy";

import type { GeminiSessionManager } from "../../gemini/session.js";
import type { GeminiProvider } from "../../gemini/provider.js";
import type { AppConfig } from "../../config.js";
import { startTyping } from "../middleware/typing.js";

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

      // Drain the stream; use 2× max duration since image generation takes longer
      let finalText = "";
      const images: Array<{ src: string; alt?: string }> = [];
      const gen = provider.streamResponse(page, baseline, {
        maxDurationMs: config.gemini.streamMaxDurationMs * 2,
        firstChunkTimeoutMs: config.gemini.streamFirstChunkTimeoutMs * 2,
      });
      let next = await gen.next();
      while (!next.done) {
        next = await gen.next();
      }
      if (next.value) {
        finalText = next.value.text ?? "";
        images.push(...(next.value.images ?? []));
      }

      stopTyping();

      if (images.length > 0) {
        const caption = finalText.trim() || undefined;
        const src = images[0].src;
        const buf = Buffer.from(src.split(",")[1], "base64");
        await ctx.replyWithPhoto(new InputFile(buf, "image.png"), { caption });
      } else if (finalText.trim()) {
        // Gemini replied with text only (e.g. declined image generation)
        await ctx.reply(finalText);
      } else {
        await ctx.reply("Gemini non ha generato immagini. Prova con una descrizione diversa.");
      }
    } catch (err) {
      stopTyping();
      const message = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Errore: ${message}`);
    }
  };
}
