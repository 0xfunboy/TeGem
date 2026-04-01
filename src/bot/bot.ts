import { Bot, InputFile } from "grammy";

import type { AppConfig } from "../config.js";
import { GeminiProvider } from "../gemini/provider.js";
import { GeminiSessionManager } from "../gemini/session.js";
import { GeminiQuotaError, GeminiTimeoutError } from "../gemini/errors.js";
import { startTyping } from "./middleware/typing.js";
import { handleStart } from "./commands/start.js";
import { handleHelp } from "./commands/help.js";
import { makeClearHandler } from "./commands/clear.js";
import { makeStatusHandler } from "./commands/status.js";
import { makeImagineHandler } from "./commands/imagine.js";

export function createBot(
  config: AppConfig,
  sessionManager: GeminiSessionManager,
  provider: GeminiProvider,
): Bot {
  const bot = new Bot(config.telegram.token);

  // ── Commands ───────────────────────────────────────────────
  bot.command("start", handleStart);
  bot.command("help", handleHelp);
  bot.command("clear", makeClearHandler(sessionManager, provider, config));
  bot.command("status", makeStatusHandler(sessionManager));
  bot.command("imagine", makeImagineHandler(sessionManager, provider, config));

  // ── Message handler ────────────────────────────────────────
  bot.on("message:text", async (ctx) => {
    const userText = ctx.message.text;

    if (userText.startsWith("/")) {
      await ctx.reply("Comando sconosciuto. Usa /help per vedere i comandi disponibili.");
      return;
    }

    const stopTyping = startTyping(ctx);
    const profilePath = sessionManager.resolveProfilePath(config.profileDir);
    const sentMsg = await ctx.reply("…");

    try {
      const session = await sessionManager.getOrCreate(provider.config, profilePath);
      const page = session.page;

      await provider.ensureReady(page);
      await provider.ensureConversationNotFull(page);

      const baseline = await provider.snapshotConversation(page);
      baseline.prompt = userText;
      await provider.sendPrompt(page, userText);

      // Stream response, editing the placeholder at regular intervals
      let accumulated = "";
      let lastEdit = Date.now();
      const EDIT_INTERVAL_MS = 1_500;

      const gen = provider.streamResponse(page, baseline);
      let next = await gen.next();

      while (!next.done) {
        accumulated += next.value as string;
        if (Date.now() - lastEdit > EDIT_INTERVAL_MS && accumulated.trim()) {
          await ctx.api
            .editMessageText(ctx.chat.id, sentMsg.message_id, accumulated + " ▌")
            .catch(() => undefined);
          lastEdit = Date.now();
        }
        next = await gen.next();
      }

      stopTyping();

      const finalResponse = next.value as { text: string; images: Array<{ src: string; alt?: string }> };
      const finalText = finalResponse.text || accumulated;
      const images = finalResponse.images ?? [];

      if (provider.isQuotaExhausted(finalText)) throw new GeminiQuotaError(finalText);

      // Send text (if any)
      if (finalText.trim()) {
        await ctx.api
          .editMessageText(ctx.chat.id, sentMsg.message_id, finalText)
          .catch(async () => ctx.reply(finalText));
      } else {
        // No text — delete the placeholder
        await ctx.api.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => undefined);
      }

      // Send images (if any)
      for (const img of images) {
        if (img.src.startsWith("data:")) {
          const buf = Buffer.from(img.src.split(",")[1], "base64");
          await ctx.replyWithPhoto(new InputFile(buf, "image.png"), { caption: img.alt || undefined });
        } else {
          await ctx.replyWithPhoto(img.src, { caption: img.alt || undefined });
        }
      }
    } catch (err) {
      stopTyping();
      const message = err instanceof Error ? err.message : String(err);
      let userMessage: string;

      if (err instanceof GeminiQuotaError) {
        userMessage = "Quota Gemini esaurita per oggi. Riprova domani.";
      } else if (err instanceof GeminiTimeoutError) {
        userMessage = `Timeout: ${message}`;
      } else if (message.includes("non pronto") || message.includes("login")) {
        userMessage = "Gemini non è pronto. Usa /status per verificare.";
      } else {
        userMessage = `Errore: ${message}`;
      }

      await ctx.api
        .editMessageText(ctx.chat.id, sentMsg.message_id, userMessage)
        .catch(async () => ctx.reply(userMessage));
    }
  });

  bot.catch((err) => {
    console.error("[TeGem] Errore non gestito:", err.message);
  });

  return bot;
}
