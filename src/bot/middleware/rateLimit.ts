import type { Context, NextFunction } from "grammy";

/**
 * Per-user rate limiter. Tracks last request timestamp per user and enforces
 * a minimum cooldown between requests. Does NOT block /start, /help, /status.
 */
export function createRateLimitMiddleware(cooldownMs: number) {
  const lastRequest = new Map<number, number>();

  // Periodic cleanup: remove entries older than 10× cooldown to prevent unbounded growth
  const cleanupIntervalMs = Math.max(cooldownMs * 10, 60_000);
  setInterval(() => {
    const cutoff = Date.now() - cleanupIntervalMs;
    for (const [userId, ts] of lastRequest) {
      if (ts < cutoff) lastRequest.delete(userId);
    }
  }, cleanupIntervalMs).unref();

  const EXEMPT_COMMANDS = new Set(["start", "help", "status"]);

  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const userId = ctx.from?.id;
    if (!userId) { await next(); return; }

    // Check if this is an exempt command
    const text = ctx.message?.text ?? ctx.message?.caption ?? "";
    const commandMatch = text.match(/^\/(\w+)/);
    if (commandMatch && EXEMPT_COMMANDS.has(commandMatch[1])) {
      await next();
      return;
    }

    // In groups, only rate-limit if the bot is actually being addressed
    // (the auth + mention logic downstream will decide; we just throttle)
    const now = Date.now();
    const last = lastRequest.get(userId);
    if (last && now - last < cooldownMs) {
      const waitSec = Math.ceil((cooldownMs - (now - last)) / 1000);
      await ctx.reply(`Too fast! Wait ${waitSec}s before sending another request.`);
      return;
    }

    lastRequest.set(userId, now);
    await next();
  };
}
