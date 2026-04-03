import type { CommandContext, Context } from "grammy";
import { InputFile } from "grammy";

import type { GeminiSessionManager } from "../../gemini/session.js";
import type { GeminiProvider } from "../../gemini/provider.js";
import { getSessionKey } from "../sessionKey.js";
import { startTyping } from "../middleware/typing.js";

export function makeVoiceHandler(
  sessionManager: GeminiSessionManager,
  provider: GeminiProvider,
) {
  return async (ctx: CommandContext<Context>): Promise<void> => {
    const sessionKey = getSessionKey(ctx);

    return sessionManager.withLock(sessionKey, async () => {
      const page = sessionManager.getPage(sessionKey);
      if (!page) {
        await ctx.reply("No active session. Write something first to get a response to read.");
        return;
      }

      const stopTyping = startTyping(ctx);

      try {
        const buf = await provider.downloadLastResponseAudio(page);
        stopTyping();

        if (buf) {
          // Detect format: MP3 starts with 0xFF 0xFB/0xF3/0xF2 or ID3, OGG starts with "OggS"
          const isOgg = buf.length > 4 && buf[0] === 0x4F && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53;
          const ext = isOgg ? "ogg" : "mp3";
          await ctx.replyWithVoice(new InputFile(buf, `voice.${ext}`));
        } else {
          await ctx.reply("Could not capture audio. Make sure there is a recent Gemini response.");
        }
      } catch (err) {
        stopTyping();
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`Error capturing audio: ${msg}`);
      }
    });
  };
}
