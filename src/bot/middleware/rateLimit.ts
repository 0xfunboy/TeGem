import type { Context, NextFunction } from "grammy";
import type { MessageEntity } from "grammy/types";

/**
 * Per-user rate limiter. Tracks last request timestamp per user and enforces
 * a minimum cooldown between requests. Does NOT block /start, /help, /status.
 */
function extractCommand(text: string): { name: string; target?: string } | null {
  const match = text.trim().match(/^\/([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9_]+))?(?:\s|$)/);
  if (!match) return null;
  return {
    name: match[1].toLowerCase(),
    target: match[2]?.toLowerCase(),
  };
}

function hasBotMention(
  text: string,
  entities: MessageEntity[],
  botUsername: string,
  botId: number,
): boolean {
  const normalizedBotMention = `@${botUsername.toLowerCase()}`;

  return entities.some((entity) => {
    if (entity.type === "mention") {
      return text.slice(entity.offset, entity.offset + entity.length).toLowerCase() === normalizedBotMention;
    }
    return entity.type === "text_mention" && entity.user?.id === botId;
  });
}

function shouldRateLimitGroupMessage(ctx: Context, botCommands: Set<string>): boolean {
  const message = ctx.message;
  if (!message) return false;

  const text = message.text ?? message.caption ?? "";
  const entities = message.text ? (message.entities ?? []) : (message.caption_entities ?? []);
  const botUsername = ctx.me.username?.toLowerCase();

  const command = extractCommand(text);
  if (command) {
    if (command.target && command.target !== botUsername) return false;
    return botCommands.has(command.name);
  }

  if (!botUsername) return false;
  return hasBotMention(text, entities, botUsername, ctx.me.id);
}

export function createRateLimitMiddleware(cooldownMs: number, commandNames: readonly string[]) {
  const lastRequest = new Map<number, number>();
  const botCommands = new Set(commandNames.map((name) => name.toLowerCase()));

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

    const text = ctx.message?.text ?? ctx.message?.caption ?? "";
    const command = extractCommand(text);

    if (command && EXEMPT_COMMANDS.has(command.name)) {
      await next();
      return;
    }

    const chatType = ctx.chat?.type;
    if ((chatType === "group" || chatType === "supergroup") && !shouldRateLimitGroupMessage(ctx, botCommands)) {
      await next();
      return;
    }

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
