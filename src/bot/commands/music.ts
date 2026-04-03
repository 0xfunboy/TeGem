import type { CommandContext, Context } from "grammy";
import { InputFile } from "grammy";

import type { GeminiSessionManager } from "../../gemini/session.js";
import type { GeminiProvider } from "../../gemini/provider.js";
import type { AppConfig } from "../../config.js";
import { getSessionKey, getSessionLabel } from "../sessionKey.js";
import { startTyping } from "../middleware/typing.js";
import {
  describeInvisibleTelegramText,
  formatForTelegram,
  hasVisibleTelegramText,
  sanitizeTelegramDisplayText,
} from "../format.js";

export function makeMusicHandler(
  sessionManager: GeminiSessionManager,
  provider: GeminiProvider,
  config: AppConfig,
) {
  return async (ctx: CommandContext<Context>): Promise<void> => {
    const args = ctx.match?.trim();
    if (!args) {
      await ctx.reply("Usage: /music <description>\nExample: `/music a lo-fi hip hop beat for studying`", { parse_mode: "Markdown" });
      return;
    }

    const stopTyping = startTyping(ctx);
    const sessionKey = getSessionKey(ctx);
    const sessionLabel = getSessionLabel(ctx);
    const replyExtra = ctx.message?.message_id
      ? { reply_parameters: { message_id: ctx.message.message_id } }
      : {};

    return sessionManager.withLock(sessionKey, async () => {
    try {
      const page = await sessionManager.getOrCreate(provider.config, sessionKey, sessionLabel);
      await provider.ensureReady(page);
      await provider.ensureConversationNotFull(page);

      const baseline = await provider.snapshotConversation(page);
      const prompt = `Create music: ${args}`;
      baseline.prompt = prompt;
      await provider.sendPrompt(page, prompt);

      // Drain stream with extended timeout for music generation
      const gen = provider.streamResponse(page, baseline, {
        maxDurationMs: config.gemini.streamMaxDurationMs * 3,
        firstChunkTimeoutMs: config.gemini.streamFirstChunkTimeoutMs * 2,
      });
      let finalText = "";
      let next = await gen.next();
      while (!next.done) next = await gen.next();
      if (next.value) finalText = next.value.text ?? "";

      const downloads = await provider.downloadGeneratedMusic(page, 90_000);
      stopTyping();

      let sentMedia = false;

      if (downloads.video) {
        sentMedia = true;
        await ctx.replyWithVideo(
          new InputFile(downloads.video.buffer, downloads.video.filename),
          replyExtra,
        );
      }

      if (downloads.audio) {
        sentMedia = true;
        await ctx.replyWithAudio(
          new InputFile(downloads.audio.buffer, downloads.audio.filename),
          replyExtra,
        );
      }

      const safeFinalText = sanitizeTelegramDisplayText(finalText);
      if (hasVisibleTelegramText(safeFinalText)) {
        await ctx.reply(formatForTelegram(finalText), { parse_mode: "HTML", ...replyExtra }).catch(async () =>
          ctx.reply(safeFinalText, replyExtra),
        );
      } else if (finalText.length > 0) {
        await ctx.reply(describeInvisibleTelegramText(finalText), replyExtra).catch(() => undefined);
        await ctx.replyWithDocument(
          new InputFile(Buffer.from(finalText, "utf8"), "gemini-response.txt"),
          {
            caption: "Raw Gemini response",
            ...replyExtra,
          },
        ).catch(() => undefined);
      } else if (!sentMedia) {
        await ctx.reply("Gemini did not generate music. Try a different description.", replyExtra);
      }
    } catch (err) {
      stopTyping();
      const message = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Error: ${message}`, replyExtra);
    }
    }); // withLock
  };
}
