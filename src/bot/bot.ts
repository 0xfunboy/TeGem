import { Bot } from "grammy";

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
import { InputFile } from "grammy";

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

    // Ignore commands that weren't matched above
    if (userText.startsWith("/")) {
      await ctx.reply(
        "Comando sconosciuto. Usa /help per vedere i comandi disponibili.",
      );
      return;
    }

    const stopTyping = startTyping(ctx);
    const profilePath = sessionManager.resolveProfilePath(config.profileDir);

    // Sent message placeholder for streaming edit
    const sentMsg = await ctx.reply("Sto elaborando…");

    try {
      // Ensure Gemini session is alive
      const session = await sessionManager.getOrCreate(provider.config, profilePath);
      const page = session.page;

      await provider.ensureReady(page);
      await provider.ensureConversationNotFull(page);

      const baseline = await provider.snapshotConversation(page);
      baseline.prompt = userText;

      // On first message per session, inject system prompt
      const messageCount = baseline.count;
      const finalPrompt =
        messageCount === 0
          ? `${config.systemPrompt}\n\n---\n\n${userText}`
          : userText;

      await provider.sendPrompt(page, finalPrompt);

      // Stream response and accumulate
      let accumulated = "";
      let lastEdit = Date.now();
      const EDIT_INTERVAL_MS = 1_500;

      const stream = provider.streamResponse(page, baseline);
      let result = await stream.next();

      while (!result.done) {
        accumulated += result.value as string;

        // Edit message at intervals to show streaming effect
        if (Date.now() - lastEdit > EDIT_INTERVAL_MS && accumulated.trim()) {
          await ctx.api
            .editMessageText(ctx.chat.id, sentMsg.message_id, accumulated + " ▌")
            .catch(() => undefined);
          lastEdit = Date.now();
        }

        result = await stream.next();
      }

      stopTyping();

      const finalResponse = result.value as { text: string; images: Array<{ src: string; alt?: string }> };
      const finalText = finalResponse.text || accumulated;
      const images = finalResponse.images ?? [];

      // Check quota
      if (provider.isQuotaExhausted(finalText)) {
        throw new GeminiQuotaError(finalText);
      }

      // Update final text
      if (finalText.trim()) {
        await ctx.api
          .editMessageText(ctx.chat.id, sentMsg.message_id, finalText)
          .catch(async () => {
            // If edit fails (message too long or identical), send new
            await ctx.reply(finalText);
          });
      } else {
        await ctx.api
          .editMessageText(ctx.chat.id, sentMsg.message_id, "Risposta vuota da Gemini. Riprova.")
          .catch(() => undefined);
      }

      // Send images if any
      for (const img of images) {
        if (img.src.startsWith("data:")) {
          const base64 = img.src.split(",")[1];
          const buffer = Buffer.from(base64, "base64");
          await ctx.replyWithPhoto(new InputFile(buffer, "image.png"), {
            caption: img.alt || undefined,
          });
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
        userMessage = `Timeout Gemini: ${message}`;
      } else if (message.includes("non pronto") || message.includes("login")) {
        userMessage = "Gemini non è pronto. Potrebbe essere necessario effettuare il login. Usa /status per verificare.";
      } else {
        userMessage = `Errore: ${message}`;
      }

      await ctx.api
        .editMessageText(ctx.chat.id, sentMsg.message_id, userMessage)
        .catch(async () => ctx.reply(userMessage));
    }
  });

  // ── Error handler ──────────────────────────────────────────
  bot.catch((err) => {
    console.error("[TeGem] Errore non gestito:", err.message);
  });

  return bot;
}
