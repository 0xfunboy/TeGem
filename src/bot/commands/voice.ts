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
        await ctx.replyWithVoice(new InputFile(buf, "voice.mp3"));
      } else {
        await ctx.reply("Could not get audio. Make sure there is a recent response.");
      }
    } catch {
      stopTyping();
      await ctx.reply("Error getting audio. Try again shortly.");
    }
  };
}
