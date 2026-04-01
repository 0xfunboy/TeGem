import { Bot, InputFile, type Context } from "grammy";

import type { AppConfig } from "../config.js";
import { GeminiProvider } from "../gemini/provider.js";
import { GeminiSessionManager } from "../gemini/session.js";
import { GeminiQuotaError, GeminiTimeoutError } from "../gemini/errors.js";
import { startTyping } from "./middleware/typing.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { handleStart } from "./commands/start.js";
import { handleHelp } from "./commands/help.js";
import { makeClearHandler } from "./commands/clear.js";
import { makeStatusHandler } from "./commands/status.js";
import { makeImagineHandler } from "./commands/imagine.js";
import { makeVoiceHandler } from "./commands/voice.js";

export function createBot(
  config: AppConfig,
  sessionManager: GeminiSessionManager,
  provider: GeminiProvider,
): Bot {
  const bot = new Bot(config.telegram.token);

  // ── Auth middleware ────────────────────────────────────────
  bot.use(createAuthMiddleware(config));

  // ── Shared Gemini query helper ─────────────────────────────
  /**
   * Sends `text` to Gemini and streams the reply back to Telegram.
   * In groups, set `replyToMsgId` to thread the response to the user's message.
   */
  async function runQuery(ctx: Context, text: string, replyToMsgId?: number): Promise<void> {
    const stopTyping = startTyping(ctx);
    const replyExtra = replyToMsgId ? { reply_parameters: { message_id: replyToMsgId } } : {};
    const sentMsg = await ctx.reply("…", replyExtra);

    const profilePath = sessionManager.resolveProfilePath(config.profileDir);

    try {
      const session = await sessionManager.getOrCreate(provider.config, profilePath);
      const page = session.page;

      await provider.ensureReady(page);
      await provider.ensureConversationNotFull(page);

      const baseline = await provider.snapshotConversation(page);
      baseline.prompt = text;
      await provider.sendPrompt(page, text);

      let accumulated = "";
      let lastEdit = Date.now();
      const EDIT_INTERVAL_MS = 1_500;

      const gen = provider.streamResponse(page, baseline);
      let next = await gen.next();

      while (!next.done) {
        accumulated += next.value as string;
        if (Date.now() - lastEdit > EDIT_INTERVAL_MS && accumulated.trim()) {
          await ctx.api
            .editMessageText(ctx.chat!.id, sentMsg.message_id, accumulated + " ▌")
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

      if (finalText.trim()) {
        await ctx.api
          .editMessageText(ctx.chat!.id, sentMsg.message_id, finalText)
          .catch(async () => ctx.reply(finalText, replyExtra));
      } else {
        await ctx.api.deleteMessage(ctx.chat!.id, sentMsg.message_id).catch(() => undefined);
      }

      for (const img of images) {
        if (img.src.startsWith("data:")) {
          const buf = Buffer.from(img.src.split(",")[1], "base64");
          await ctx.replyWithPhoto(new InputFile(buf, "image.png"), {
            caption: img.alt || undefined,
            ...replyExtra,
          });
        } else {
          await ctx.replyWithPhoto(img.src, { caption: img.alt || undefined, ...replyExtra });
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
        .editMessageText(ctx.chat!.id, sentMsg.message_id, userMessage)
        .catch(async () => ctx.reply(userMessage, replyExtra));
    }
  }

  // ── Commands ───────────────────────────────────────────────
  bot.command("start", handleStart);
  bot.command("help", handleHelp);
  bot.command("clear", makeClearHandler(sessionManager, provider, config));
  bot.command("status", makeStatusHandler(sessionManager));
  bot.command("imagine", makeImagineHandler(sessionManager, provider, config));
  bot.command("voice", makeVoiceHandler(sessionManager, provider));

  // /q — natural language query, works in both groups and private
  bot.command("q", async (ctx) => {
    const text = ctx.match?.trim();
    if (!text) {
      await ctx.reply("Uso: /q <domanda>\nEsempio: /q qual è la capitale della Francia?");
      return;
    }
    await runQuery(ctx, text, ctx.message?.message_id);
  });

  // ── Message handler ────────────────────────────────────────
  bot.on("message:text", async (ctx) => {
    const msg = ctx.message;
    const text = msg.text;
    const chatType = ctx.chat.type;

    if (chatType === "private") {
      // Private chat: respond to everything except unknown slash commands
      if (text.startsWith("/")) {
        await ctx.reply("Comando sconosciuto. Usa /help per vedere i comandi disponibili.");
        return;
      }
      await runQuery(ctx, text);
      return;
    }

    // Groups / supergroups: only respond when @mentioned
    if (chatType === "group" || chatType === "supergroup") {
      const botUsername = ctx.me.username;
      const entities = msg.entities ?? [];

      const isMentioned = entities.some(
        (e) =>
          (e.type === "mention" && text.slice(e.offset, e.offset + e.length) === `@${botUsername}`) ||
          (e.type === "text_mention" && e.user?.id === ctx.me.id),
      );

      if (!isMentioned) return;

      // Strip all @botname mentions from the text
      let question = text;
      for (const e of [...entities].reverse()) {
        if (
          (e.type === "mention" && text.slice(e.offset, e.offset + e.length) === `@${botUsername}`) ||
          (e.type === "text_mention" && e.user?.id === ctx.me.id)
        ) {
          question = question.slice(0, e.offset) + question.slice(e.offset + e.length);
        }
      }
      question = question.trim();

      // If tagged in a reply to another message, prepend that context
      const replyText = msg.reply_to_message?.text?.trim();
      if (replyText) {
        question = question
          ? `[Messaggio di riferimento: "${replyText}"]\n\n${question}`
          : replyText;
      }

      if (!question) {
        await ctx.reply("Dimmi pure!", { reply_parameters: { message_id: msg.message_id } });
        return;
      }

      await runQuery(ctx, question, msg.message_id);
    }
  });

  bot.catch((err) => {
    console.error("[TeGem] Errore non gestito:", err.message);
  });

  return bot;
}
