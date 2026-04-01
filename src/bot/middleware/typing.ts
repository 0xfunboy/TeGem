import type { Context } from "grammy";

/**
 * Sends a typing indicator to the chat and repeats it every 4s until stopped.
 * Returns a stop function.
 */
export function startTyping(ctx: Context): () => void {
  let stopped = false;

  const send = (): void => {
    if (stopped) return;
    ctx.api.sendChatAction(ctx.chat!.id, "typing").catch(() => undefined);
    if (!stopped) setTimeout(send, 4_000);
  };

  send();

  return () => { stopped = true; };
}
