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

      // Inject system prompt silently if this is a fresh conversation
      let baseline = await provider.snapshotConversation(page);
      if (baseline.count === 0) {
        await provider.injectSystemPrompt(page, config.systemPrompt);
        baseline = await provider.snapshotConversation(page);
      }

      const prompt = `genera un'immagine: ${args}`;
      baseline.prompt = prompt;
      await provider.sendPrompt(page, prompt);

      // Drain the stream — image responses produce little/no text chunks
      let finalText = "";
      const gen = provider.streamResponse(page, baseline);
      let next = await gen.next();
      while (!next.done) {
        next = await gen.next();
      }
      if (next.value) finalText = next.value.text;

      // Primary: download the full-resolution image via Gemini's download button
      let imageBuffer = await provider.downloadLastImage(page);

      // Fallback: screenshot the last response container
      if (!imageBuffer) {
        const screenshots = await provider.screenshotLastResponse(page);
        if (screenshots.length > 0) {
          const src = screenshots[0].src;
          if (src.startsWith("data:")) {
            imageBuffer = Buffer.from(src.split(",")[1], "base64");
          }
        }
      }

      stopTyping();

      if (imageBuffer) {
        // Send image only (caption = text if present, else the prompt)
        const caption = finalText.trim() || undefined;
        await ctx.replyWithPhoto(new InputFile(imageBuffer, "image.png"), { caption });
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
