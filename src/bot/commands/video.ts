import type { CommandContext, Context } from "grammy";
import { InputFile } from "grammy";

import type { GeminiSessionManager } from "../../gemini/session.js";
import type { GeminiProvider } from "../../gemini/provider.js";
import type { AppConfig } from "../../config.js";
import { getSessionKey, getSessionLabel } from "../sessionKey.js";
import { startTyping } from "../middleware/typing.js";

export function makeVideoHandler(
  sessionManager: GeminiSessionManager,
  provider: GeminiProvider,
  config: AppConfig,
) {
  return async (ctx: CommandContext<Context>): Promise<void> => {
    const args = ctx.match?.trim();
    if (!args) {
      await ctx.reply("Usage: /video <description>\nExample: `/video a cat playing piano`", { parse_mode: "Markdown" });
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
      const prompt = `Create a video: ${args}`;
      baseline.prompt = prompt;
      await provider.sendPrompt(page, prompt);

      // Video generation can take a very long time — use 5× max timeout
      const gen = provider.streamResponse(page, baseline, {
        maxDurationMs: config.gemini.streamMaxDurationMs * 5,
        firstChunkTimeoutMs: config.gemini.streamFirstChunkTimeoutMs * 3,
      });
      let finalText = "";
      let next = await gen.next();
      while (!next.done) next = await gen.next();
      if (next.value) finalText = next.value.text ?? "";

      // Try to download the generated video (extended timeout)
      const media = await provider.downloadGeneratedMedia(page, 180_000);
      stopTyping();

      if (media) {
        await ctx.replyWithVideo(
          new InputFile(media.buffer, media.filename),
          replyExtra,
        );
      }

      if (finalText.trim()) {
        await ctx.reply(finalText, replyExtra);
      } else if (!media) {
        await ctx.reply("Gemini did not generate a video. Try a different description.", replyExtra);
      }
    } catch (err) {
      stopTyping();
      const message = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Error: ${message}`, replyExtra);
    }
    }); // withLock
  };
}
