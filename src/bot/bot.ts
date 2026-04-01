import { Bot, InputFile, type Context } from "grammy";
import type { Message, MessageEntity } from "grammy/types";

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

/**
 * Given a message that @mentions the bot, returns the composed prompt:
 *  - strips @mention(s) from the text
 *  - if the message is a reply, appends the replied-to text with sender attribution:
 *      "{question} di {senderName}:\n\n{repliedText}"
 *  - if mention-only with no reply, returns ""
 * Returns null if no bot mention is present.
 */
function resolveMentionQuestion(
  text: string,
  entities: MessageEntity[],
  botUsername: string,
  botId: number,
  replyMsg: Message | undefined,
): string | null {
  const isMentioned = entities.some(
    (e) =>
      (e.type === "mention" && text.slice(e.offset, e.offset + e.length) === `@${botUsername}`) ||
      (e.type === "text_mention" && e.user?.id === botId),
  );
  if (!isMentioned) return null;

  // Strip all bot mentions (iterate in reverse to preserve offsets)
  let question = text;
  for (const e of [...entities].reverse()) {
    if (
      (e.type === "mention" && text.slice(e.offset, e.offset + e.length) === `@${botUsername}`) ||
      (e.type === "text_mention" && e.user?.id === botId)
    ) {
      question = question.slice(0, e.offset) + question.slice(e.offset + e.length);
    }
  }
  question = question.trim();

  // Include replied-to message context
  const replyText = replyMsg?.text?.trim() ?? replyMsg?.caption?.trim() ?? "";
  if (replyText) {
    if (question) {
      const sender = replyMsg?.from;
      let senderName = [sender?.first_name, sender?.last_name].filter(Boolean).join(" ").trim();
      if (!senderName && sender?.username) senderName = `@${sender.username}`;
      const attribution = senderName ? ` di ${senderName}` : "";
      question = `${question}${attribution}:\n\n${replyText}`;
    } else {
      question = replyText;
    }
  }

  return question;
}

export function createBot(
  config: AppConfig,
  sessionManager: GeminiSessionManager,
  provider: GeminiProvider,
): Bot {
  const bot = new Bot(config.telegram.token);

  // ── Auth middleware ────────────────────────────────────────
  bot.use(createAuthMiddleware(config));

  // ── Shared Gemini query helper ─────────────────────────────
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
    const botUsername = ctx.me.username ?? "";
    const botId = ctx.me.id;
    const entities = msg.entities ?? [];

    if (chatType === "private") {
      if (text.startsWith("/")) {
        await ctx.reply("Comando sconosciuto. Usa /help per vedere i comandi disponibili.");
        return;
      }

      // If the message contains an @mention of the bot, strip it and compose
      // the prompt (same logic as group mentions, so reply context works too).
      const mentionQuestion = resolveMentionQuestion(
        text, entities, botUsername, botId, msg.reply_to_message,
      );

      if (mentionQuestion !== null) {
        if (!mentionQuestion) {
          await ctx.reply("Dimmi pure! Cosa vuoi sapere?");
          return;
        }
        await runQuery(ctx, mentionQuestion);
        return;
      }

      // No @mention — send the plain text as-is
      await runQuery(ctx, text);
      return;
    }

    // Groups / supergroups: only respond when @mentioned
    if (chatType === "group" || chatType === "supergroup") {
      const question = resolveMentionQuestion(
        text, entities, botUsername, botId, msg.reply_to_message,
      );

      if (question === null) return; // not mentioned

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
