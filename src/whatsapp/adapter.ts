import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import qrcodeTerminal from "qrcode-terminal";
import WhatsAppWebJs from "whatsapp-web.js";

import type { AppConfig } from "../config.js";
import { GeminiQuotaError, GeminiTimeoutError } from "../gemini/errors.js";
import { GeminiProvider } from "../gemini/provider.js";
import { GeminiSessionManager } from "../gemini/session.js";
import { getWhatsappSessionKey, getWhatsappSessionLabel } from "./sessionKey.js";

const { Client, LocalAuth, MessageMedia } = WhatsAppWebJs;

type WhatsAppClient = InstanceType<typeof Client>;
type WhatsAppMessage = Awaited<ReturnType<WhatsAppClient["getMessageById"]>>;
type WhatsAppChat = Awaited<ReturnType<WhatsAppClient["getChatById"]>>;
type WhatsAppSendOptions = Exclude<Parameters<WhatsAppChat["sendMessage"]>[1], undefined>;

const WHATSAPP_MAX_TEXT_LEN = 3500;
const UNAUTHORIZED_MESSAGE =
  "Utente o gruppo non autorizzato. Contatta @funboynft per richiedere accesso.";

export interface WhatsAppAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
}

type MentionResolution = {
  question: string | null;
  replyTargetId: string;
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeDisplayText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

function hasVisibleText(text: string): boolean {
  return sanitizeDisplayText(text).replace(/[\s\u200B-\u200D\uFEFF]/g, "").length > 0;
}

function describeInvisibleText(text: string): string {
  const count = Array.from(text).length;
  return `Gemini ha generato ${count} caratteri non facilmente visualizzabili qui. Ti invio il testo come file.`;
}

function splitText(text: string, maxLen = WHATSAPP_MAX_TEXT_LEN): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let breakAt = remaining.lastIndexOf("\n", maxLen);
    if (breakAt <= 0) breakAt = remaining.lastIndexOf(" ", maxLen);
    if (breakAt <= 0) breakAt = maxLen;

    chunks.push(remaining.slice(0, breakAt).trimEnd());
    remaining = remaining.slice(breakAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

function extractCommand(text: string): { name: string; args: string } | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/([a-zA-Z0-9_]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return {
    name: match[1].toLowerCase(),
    args: match[2]?.trim() ?? "",
  };
}

function resolveCaptionQueryCommand(caption: string): string | null {
  const trimmed = caption.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^\/q(?:\s+([\s\S]*))?$/i);
  if (!match) return null;

  return match[1]?.trim() || "Describe this image";
}

function getFileExtension(mimeType?: string, filename?: string | null): string {
  const fromName = filename?.split(".").pop()?.toLowerCase();
  if (fromName) return fromName;

  const normalized = mimeType?.split(";")[0]?.trim().toLowerCase();
  switch (normalized) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "video/mp4":
      return "mp4";
    case "audio/mpeg":
      return "mp3";
    case "audio/ogg":
      return "ogg";
    case "text/plain":
      return "txt";
    default:
      return normalized?.split("/")[1] || "bin";
  }
}

function makeReplyOptions(quotedMessageId?: string): WhatsAppSendOptions {
  return quotedMessageId ? { quotedMessageId } : {};
}

function createMedia(buffer: Buffer, mimeType: string, filename: string) {
  return new MessageMedia(mimeType, buffer.toString("base64"), filename, buffer.length);
}

function createTextDocument(text: string, filename: string) {
  const buffer = Buffer.from(text, "utf8");
  return new MessageMedia("text/plain", buffer.toString("base64"), filename, buffer.length);
}

function createDataUrlMedia(dataUrl: string, fallbackFilename: string) {
  const [meta, data] = dataUrl.split(",", 2);
  const mimeType = meta.match(/^data:([^;]+);base64$/)?.[1] ?? "application/octet-stream";
  const extension = getFileExtension(mimeType, fallbackFilename);
  const filename = fallbackFilename.includes(".") ? fallbackFilename : `${fallbackFilename}.${extension}`;
  return new MessageMedia(mimeType, data, filename);
}

function getMessageText(message: WhatsAppMessage): string {
  return (message.body ?? "").trim();
}

function getSenderId(chat: WhatsAppChat, message: WhatsAppMessage): string {
  return chat.isGroup ? (message.author ?? message.from) : message.from;
}

function stripOwnMentions(text: string, selfId: string): string {
  const selfUser = selfId.split("@")[0];
  const mentionPattern = new RegExp(`@\\+?${escapeRegex(selfUser)}\\b`, "gi");
  return text.replace(mentionPattern, " ").replace(/\s{2,}/g, " ").trim();
}

async function cleanupTempFile(filePath: string): Promise<void> {
  try {
    const dir = path.dirname(filePath);
    if (path.basename(dir).startsWith("tegem-")) {
      await rm(dir, { recursive: true, force: true });
    } else {
      await rm(filePath, { force: true });
    }
  } catch {
    // best-effort
  }
}

async function downloadMessageMediaToTemp(message: WhatsAppMessage): Promise<string | null> {
  try {
    const media = await message.downloadMedia();
    if (!media) return null;

    const dir = await mkdtemp(path.join(tmpdir(), "tegem-"));
    const ext = getFileExtension(media.mimetype, media.filename);
    const baseName = path.basename(media.filename || `upload.${ext}`);
    const localPath = path.join(dir, baseName);
    await writeFile(localPath, Buffer.from(media.data, "base64"));
    return localPath;
  } catch {
    return null;
  }
}

async function getQuotedMessageSafe(message: WhatsAppMessage): Promise<WhatsAppMessage | null> {
  if (!message.hasQuotedMsg) return null;
  try {
    return await message.getQuotedMessage();
  } catch {
    return null;
  }
}

async function getSenderName(message: WhatsAppMessage): Promise<string> {
  try {
    const contact = await message.getContact();
    return contact.pushname || contact.shortName || contact.name || contact.number || message.from;
  } catch {
    return message.author ?? message.from;
  }
}

function startTyping(chat: WhatsAppChat): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = (): void => {
    if (stopped) return;
    void chat.sendStateTyping().catch(() => undefined);
    timer = setTimeout(tick, 20_000);
    timer.unref?.();
  };

  tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    void chat.clearState().catch(() => undefined);
  };
}

export function createWhatsAppAdapter(
  config: AppConfig,
  sessionManager: GeminiSessionManager,
  provider: GeminiProvider,
): WhatsAppAdapter {
  const dataPath = sessionManager.resolveProfilePath(config.whatsapp.authDirName);
  const webVersionCachePath = sessionManager.resolveProfilePath("_whatsapp-web-cache");

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: config.whatsapp.sessionId,
      dataPath,
    }),
    authTimeoutMs: 60_000,
    qrMaxRetries: 0,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 5_000,
    deviceName: config.whatsapp.deviceName,
    browserName: "Chrome",
    pairWithPhoneNumber: config.whatsapp.pairingPhoneNumber
      ? { phoneNumber: config.whatsapp.pairingPhoneNumber }
      : undefined,
    webVersionCache: {
      type: "local",
      path: webVersionCachePath,
      strict: false,
    },
    puppeteer: {
      headless: config.gemini.headless,
      executablePath: config.gemini.browserExecutablePath,
      channel: config.gemini.browserExecutablePath ? undefined : config.gemini.browserChannel,
      args: [
        "--window-size=1440,960",
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--disable-setuid-sandbox",
      ],
    },
  });

  const lastRequest = new Map<string, number>();
  const cleanupIntervalMs = Math.max(config.rateLimitMs * 10, 60_000);
  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - cleanupIntervalMs;
    for (const [userId, timestamp] of lastRequest) {
      if (timestamp < cutoff) lastRequest.delete(userId);
    }
  }, cleanupIntervalMs);
  cleanupTimer.unref();

  let started = false;

  async function sendInvisibleTextFallback(
    chat: WhatsAppChat,
    text: string,
    quotedMessageId?: string,
    editTarget?: WhatsAppMessage,
  ): Promise<void> {
    const notice = describeInvisibleText(text);

    if (editTarget) {
      const edited = await editTarget.edit(notice).then(() => true).catch(() => false);
      if (!edited) {
        await chat.sendMessage(notice, makeReplyOptions(quotedMessageId)).catch(() => undefined);
      }
    } else {
      await chat.sendMessage(notice, makeReplyOptions(quotedMessageId)).catch(() => undefined);
    }

    await chat.sendMessage(createTextDocument(text, "gemini-response.txt"), {
      caption: "Raw Gemini response",
      sendMediaAsDocument: true,
      ...makeReplyOptions(quotedMessageId),
    }).catch(() => undefined);
  }

  async function sendTextChunks(
    chat: WhatsAppChat,
    text: string,
    quotedMessageId: string | undefined,
    editTarget?: WhatsAppMessage,
  ): Promise<void> {
    const chunks = splitText(sanitizeDisplayText(text));
    if (chunks.length === 0) return;

    if (editTarget) {
      const edited = await editTarget.edit(chunks[0]).then(() => true).catch(() => false);
      if (!edited) {
        await chat.sendMessage(chunks[0], makeReplyOptions(quotedMessageId));
      }
    } else {
      await chat.sendMessage(chunks[0], makeReplyOptions(quotedMessageId));
    }

    for (let index = 1; index < chunks.length; index += 1) {
      await chat.sendMessage(chunks[index], makeReplyOptions(quotedMessageId)).catch(() => undefined);
    }
  }

  async function sendResponseImages(
    chat: WhatsAppChat,
    images: Array<{ src: string; alt?: string }>,
    quotedMessageId?: string,
  ): Promise<void> {
    for (const [index, image] of images.entries()) {
      const caption = image.alt && hasVisibleText(image.alt) ? sanitizeDisplayText(image.alt) : undefined;
      if (image.src.startsWith("data:")) {
        const media = createDataUrlMedia(image.src, `generated-image-${index + 1}.png`);
        await chat.sendMessage(media, { caption, ...makeReplyOptions(quotedMessageId) }).catch(() => undefined);
        continue;
      }

      const media = await MessageMedia.fromUrl(image.src, { unsafeMime: true }).catch(() => null);
      if (media) {
        await chat.sendMessage(media, { caption, ...makeReplyOptions(quotedMessageId) }).catch(() => undefined);
      }
    }
  }

  async function sendDownloadedMedia(
    chat: WhatsAppChat,
    buffer: Buffer,
    mimeType: string,
    filename: string,
    quotedMessageId?: string,
    options: Partial<WhatsAppSendOptions> = {},
  ): Promise<void> {
    const media = createMedia(buffer, mimeType, filename);
    await chat.sendMessage(media, {
      ...options,
      ...makeReplyOptions(quotedMessageId),
    }).catch(() => undefined);
  }

  async function resolveMentionQuestion(message: WhatsAppMessage): Promise<MentionResolution> {
    const selfId = client.info?.wid?._serialized;
    const defaultReplyTarget = message.id._serialized;
    if (!selfId || !message.mentionedIds.includes(selfId)) {
      return { question: null, replyTargetId: defaultReplyTarget };
    }

    let question = stripOwnMentions(getMessageText(message), selfId);
    const quoted = await getQuotedMessageSafe(message);
    const replyTargetId = quoted?.id._serialized ?? defaultReplyTarget;
    const quotedText = quoted ? getMessageText(quoted) : "";

    if (quoted && quotedText) {
      if (question) {
        const senderName = await getSenderName(quoted);
        const attribution = senderName ? ` di ${senderName}` : "";
        question = `${question}${attribution}:\n\n${quotedText}`;
      } else {
        question = quotedText;
      }
    }

    return { question, replyTargetId };
  }

  async function ensureAuthorized(chat: WhatsAppChat, message: WhatsAppMessage): Promise<boolean> {
    if (!chat.isGroup) {
      const senderId = getSenderId(chat, message);
      if (
        config.whatsapp.allowedUsers.length === 0 ||
        !config.whatsapp.allowedUsers.includes(senderId)
      ) {
        await chat.sendMessage(UNAUTHORIZED_MESSAGE, makeReplyOptions(message.id._serialized)).catch(() => undefined);
        return false;
      }
      return true;
    }

    const groupId = chat.id._serialized;
    if (
      config.whatsapp.allowedGroups.length === 0 ||
      !config.whatsapp.allowedGroups.includes(groupId)
    ) {
      return false;
    }

    return true;
  }

  async function enforceRateLimit(
    chat: WhatsAppChat,
    senderId: string,
    message: WhatsAppMessage,
    commandName?: string,
  ): Promise<boolean> {
    if (config.rateLimitMs <= 0) return true;

    const exemptCommands = new Set(["start", "help", "status"]);
    if (commandName && exemptCommands.has(commandName)) return true;

    const now = Date.now();
    const previous = lastRequest.get(senderId);
    if (previous && now - previous < config.rateLimitMs) {
      const waitSec = Math.ceil((config.rateLimitMs - (now - previous)) / 1000);
      await chat.sendMessage(
        `Troppo veloce. Aspetta ${waitSec}s prima di inviare un'altra richiesta.`,
        makeReplyOptions(message.id._serialized),
      ).catch(() => undefined);
      return false;
    }

    lastRequest.set(senderId, now);
    return true;
  }

  async function runQuery(
    chat: WhatsAppChat,
    message: WhatsAppMessage,
    text: string,
    replyTargetId?: string,
    mediaFilePath?: string,
  ): Promise<void> {
    const stopTyping = startTyping(chat);
    const sentMessage = await chat.sendMessage("…", makeReplyOptions(replyTargetId));
    const senderName = await getSenderName(message);
    const senderId = getSenderId(chat, message);
    const sessionKey = getWhatsappSessionKey(chat.id._serialized, senderId, chat.isGroup);
    const sessionLabel = getWhatsappSessionLabel(chat.name, senderName, chat.isGroup);

    return sessionManager.withLock(sessionKey, async () => {
      try {
        const page = await sessionManager.getOrCreate(provider.config, sessionKey, sessionLabel);

        await provider.ensureReady(page);
        await provider.ensureConversationNotFull(page);

        if (mediaFilePath) {
          await provider.uploadFile(page, mediaFilePath);
        }

        const baseline = await provider.snapshotConversation(page);
        baseline.prompt = text;
        await provider.sendPrompt(page, text);

        let accumulated = "";
        let lastEditAt = Date.now();
        const editIntervalMs = 1_500;

        const stream = provider.streamResponse(page, baseline);
        let next = await stream.next();

        while (!next.done) {
          accumulated += next.value as string;
          const preview = sanitizeDisplayText(accumulated);
          if (
            Date.now() - lastEditAt > editIntervalMs &&
            hasVisibleText(preview)
          ) {
            const chunk = splitText(`${preview} ▌`, WHATSAPP_MAX_TEXT_LEN)[0];
            await sentMessage.edit(chunk).catch(() => undefined);
            lastEditAt = Date.now();
          }
          next = await stream.next();
        }

        stopTyping();

        const finalResponse = next.value as { text: string; images: Array<{ src: string; alt?: string }> };
        const finalText = finalResponse.text || accumulated;
        const safeFinalText = sanitizeDisplayText(finalText);
        const images = finalResponse.images ?? [];

        if (provider.isQuotaExhausted(finalText)) throw new GeminiQuotaError(finalText);

        if (hasVisibleText(safeFinalText)) {
          await sendTextChunks(chat, safeFinalText, replyTargetId, sentMessage);
        } else if (finalText.length > 0) {
          await sendInvisibleTextFallback(chat, finalText, replyTargetId, sentMessage);
        } else {
          await sentMessage.delete(true).catch(() => sentMessage.delete(false).catch(() => undefined));
        }

        if (images.length > 0) {
          await sendResponseImages(chat, images, replyTargetId);
        }

        if (await provider.hasGeneratedPlayableMedia(page)) {
          const downloads = await provider.downloadGeneratedMusic(page, 20_000);
          let sentPlayableMedia = false;

          if (downloads.video) {
            sentPlayableMedia = true;
            await sendDownloadedMedia(
              chat,
              downloads.video.buffer,
              downloads.video.mimeType,
              downloads.video.filename,
              replyTargetId,
            );
          }

          if (downloads.audio) {
            sentPlayableMedia = true;
            await sendDownloadedMedia(
              chat,
              downloads.audio.buffer,
              downloads.audio.mimeType,
              downloads.audio.filename,
              replyTargetId,
            );
          }

          if (!sentPlayableMedia) {
            const media = await provider.downloadGeneratedMedia(page, 20_000);
            if (media) {
              await sendDownloadedMedia(
                chat,
                media.buffer,
                media.mimeType,
                media.filename,
                replyTargetId,
              );
            }
          }
        }
      } catch (error) {
        stopTyping();
        const messageText = error instanceof Error ? error.message : String(error);
        let userMessage: string;

        if (error instanceof GeminiQuotaError) {
          userMessage = "Quota Gemini esaurita per oggi. Riprova domani.";
        } else if (error instanceof GeminiTimeoutError) {
          userMessage = `Timeout: ${messageText}`;
        } else if (messageText.includes("non pronto") || messageText.includes("login")) {
          userMessage = "Gemini non è pronto. Usa /status per verificare.";
        } else {
          userMessage = `Errore: ${messageText}`;
        }

        await sentMessage.edit(userMessage).catch(async () => {
          await chat.sendMessage(userMessage, makeReplyOptions(replyTargetId)).catch(() => undefined);
        });
      } finally {
        if (mediaFilePath) await cleanupTempFile(mediaFilePath);
      }
    });
  }

  async function handleImagine(chat: WhatsAppChat, message: WhatsAppMessage, args: string): Promise<void> {
    if (!args) {
      await chat.sendMessage(
        "Uso: /imagine <descrizione>\n\nEsempio: /imagine un tramonto sul mare con colori vividi",
        makeReplyOptions(message.id._serialized),
      ).catch(() => undefined);
      return;
    }

    const stopTyping = startTyping(chat);
    const senderName = await getSenderName(message);
    const senderId = getSenderId(chat, message);
    const sessionKey = getWhatsappSessionKey(chat.id._serialized, senderId, chat.isGroup);
    const sessionLabel = getWhatsappSessionLabel(chat.name, senderName, chat.isGroup);

    return sessionManager.withLock(sessionKey, async () => {
      try {
        const page = await sessionManager.getOrCreate(provider.config, sessionKey, sessionLabel);

        await provider.ensureReady(page);
        await provider.ensureConversationNotFull(page);

        const baseline = await provider.snapshotConversation(page);
        const prompt = `genera un'immagine: ${args}`;
        baseline.prompt = prompt;
        await provider.sendPrompt(page, prompt);

        let finalText = "";
        const images: Array<{ src: string; alt?: string }> = [];
        const stream = provider.streamResponse(page, baseline, {
          maxDurationMs: config.gemini.streamMaxDurationMs * 2,
          firstChunkTimeoutMs: config.gemini.streamFirstChunkTimeoutMs * 2,
        });

        let next = await stream.next();
        while (!next.done) {
          next = await stream.next();
        }

        if (next.value) {
          finalText = next.value.text ?? "";
          images.push(...(next.value.images ?? []));
        }

        stopTyping();

        if (images.length > 0) {
          const caption = hasVisibleText(finalText) ? sanitizeDisplayText(finalText) : undefined;
          const firstImage = images[0];
          const media = firstImage.src.startsWith("data:")
            ? createDataUrlMedia(firstImage.src, "generated-image.png")
            : await MessageMedia.fromUrl(firstImage.src, { unsafeMime: true }).catch(() => null);

          if (media) {
            await chat.sendMessage(media, {
              caption,
              ...makeReplyOptions(message.id._serialized),
            }).catch(() => undefined);
          }

          if (finalText.length > 0 && !hasVisibleText(finalText)) {
            await sendInvisibleTextFallback(chat, finalText, message.id._serialized);
          }
          return;
        }

        if (hasVisibleText(finalText)) {
          await sendTextChunks(chat, finalText, message.id._serialized);
        } else if (finalText.length > 0) {
          await sendInvisibleTextFallback(chat, finalText, message.id._serialized);
        } else {
          await chat.sendMessage(
            "Gemini non ha generato immagini. Prova con una descrizione diversa.",
            makeReplyOptions(message.id._serialized),
          ).catch(() => undefined);
        }
      } catch (error) {
        stopTyping();
        const messageText = error instanceof Error ? error.message : String(error);
        await chat.sendMessage(
          `Errore: ${messageText}`,
          makeReplyOptions(message.id._serialized),
        ).catch(() => undefined);
      }
    });
  }

  async function handleMusic(chat: WhatsAppChat, message: WhatsAppMessage, args: string): Promise<void> {
    if (!args) {
      await chat.sendMessage(
        "Uso: /music <descrizione>\nEsempio: /music a lo-fi hip hop beat for studying",
        makeReplyOptions(message.id._serialized),
      ).catch(() => undefined);
      return;
    }

    const stopTyping = startTyping(chat);
    const senderName = await getSenderName(message);
    const senderId = getSenderId(chat, message);
    const sessionKey = getWhatsappSessionKey(chat.id._serialized, senderId, chat.isGroup);
    const sessionLabel = getWhatsappSessionLabel(chat.name, senderName, chat.isGroup);
    const replyTargetId = message.id._serialized;

    return sessionManager.withLock(sessionKey, async () => {
      try {
        const page = await sessionManager.getOrCreate(provider.config, sessionKey, sessionLabel);
        await provider.ensureReady(page);
        await provider.ensureConversationNotFull(page);

        const baseline = await provider.snapshotConversation(page);
        const prompt = `Create music: ${args}`;
        baseline.prompt = prompt;
        await provider.sendPrompt(page, prompt);

        const stream = provider.streamResponse(page, baseline, {
          maxDurationMs: config.gemini.streamMaxDurationMs * 3,
          firstChunkTimeoutMs: config.gemini.streamFirstChunkTimeoutMs * 2,
        });

        let finalText = "";
        let next = await stream.next();
        while (!next.done) next = await stream.next();
        if (next.value) finalText = next.value.text ?? "";

        const downloads = await provider.downloadGeneratedMusic(page, 90_000);
        stopTyping();

        let sentMedia = false;

        if (downloads.video) {
          sentMedia = true;
          await sendDownloadedMedia(
            chat,
            downloads.video.buffer,
            downloads.video.mimeType,
            downloads.video.filename,
            replyTargetId,
          );
        }

        if (downloads.audio) {
          sentMedia = true;
          await sendDownloadedMedia(
            chat,
            downloads.audio.buffer,
            downloads.audio.mimeType,
            downloads.audio.filename,
            replyTargetId,
          );
        }

        if (hasVisibleText(finalText)) {
          await sendTextChunks(chat, finalText, replyTargetId);
        } else if (finalText.length > 0) {
          await sendInvisibleTextFallback(chat, finalText, replyTargetId);
        } else if (!sentMedia) {
          await chat.sendMessage(
            "Gemini non ha generato musica. Prova con una descrizione diversa.",
            makeReplyOptions(replyTargetId),
          ).catch(() => undefined);
        }
      } catch (error) {
        stopTyping();
        const messageText = error instanceof Error ? error.message : String(error);
        await chat.sendMessage(
          `Errore: ${messageText}`,
          makeReplyOptions(replyTargetId),
        ).catch(() => undefined);
      }
    });
  }

  async function handleVideo(chat: WhatsAppChat, message: WhatsAppMessage, args: string): Promise<void> {
    if (!args) {
      await chat.sendMessage(
        "Uso: /video <descrizione>\nEsempio: /video a cat playing piano",
        makeReplyOptions(message.id._serialized),
      ).catch(() => undefined);
      return;
    }

    const stopTyping = startTyping(chat);
    const senderName = await getSenderName(message);
    const senderId = getSenderId(chat, message);
    const sessionKey = getWhatsappSessionKey(chat.id._serialized, senderId, chat.isGroup);
    const sessionLabel = getWhatsappSessionLabel(chat.name, senderName, chat.isGroup);
    const replyTargetId = message.id._serialized;

    return sessionManager.withLock(sessionKey, async () => {
      try {
        const page = await sessionManager.getOrCreate(provider.config, sessionKey, sessionLabel);
        await provider.ensureReady(page);
        await provider.ensureConversationNotFull(page);

        const baseline = await provider.snapshotConversation(page);
        const prompt = `Create a video: ${args}`;
        baseline.prompt = prompt;
        await provider.sendPrompt(page, prompt);

        const stream = provider.streamResponse(page, baseline, {
          maxDurationMs: config.gemini.streamMaxDurationMs * 5,
          firstChunkTimeoutMs: config.gemini.streamFirstChunkTimeoutMs * 3,
        });

        let finalText = "";
        let next = await stream.next();
        while (!next.done) next = await stream.next();
        if (next.value) finalText = next.value.text ?? "";

        const media = await provider.downloadGeneratedMedia(page, 180_000);
        stopTyping();

        if (media) {
          await sendDownloadedMedia(
            chat,
            media.buffer,
            media.mimeType,
            media.filename,
            replyTargetId,
          );
        }

        if (hasVisibleText(finalText)) {
          await sendTextChunks(chat, finalText, replyTargetId);
        } else if (finalText.length > 0) {
          await sendInvisibleTextFallback(chat, finalText, replyTargetId);
        } else if (!media) {
          await chat.sendMessage(
            "Gemini non ha generato un video. Prova con una descrizione diversa.",
            makeReplyOptions(replyTargetId),
          ).catch(() => undefined);
        }
      } catch (error) {
        stopTyping();
        const messageText = error instanceof Error ? error.message : String(error);
        await chat.sendMessage(
          `Errore: ${messageText}`,
          makeReplyOptions(replyTargetId),
        ).catch(() => undefined);
      }
    });
  }

  async function handleVoice(chat: WhatsAppChat, message: WhatsAppMessage): Promise<void> {
    const senderId = getSenderId(chat, message);
    const sessionKey = getWhatsappSessionKey(chat.id._serialized, senderId, chat.isGroup);
    const replyTargetId = message.id._serialized;

    return sessionManager.withLock(sessionKey, async () => {
      const page = sessionManager.getPage(sessionKey);
      if (!page) {
        await chat.sendMessage(
          "Nessuna sessione attiva. Scrivimi prima qualcosa così posso leggerne la risposta.",
          makeReplyOptions(replyTargetId),
        ).catch(() => undefined);
        return;
      }

      const stopTyping = startTyping(chat);

      try {
        const buffer = await provider.downloadLastResponseAudio(page);
        stopTyping();

        if (!buffer) {
          await chat.sendMessage(
            "Non sono riuscito a catturare l'audio. Assicurati che ci sia una risposta Gemini recente.",
            makeReplyOptions(replyTargetId),
          ).catch(() => undefined);
          return;
        }

        const isOgg = buffer.length > 4 &&
          buffer[0] === 0x4F &&
          buffer[1] === 0x67 &&
          buffer[2] === 0x67 &&
          buffer[3] === 0x53;
        const filename = isOgg ? "voice.ogg" : "voice.mp3";
        const mimeType = isOgg ? "audio/ogg" : "audio/mpeg";

        await sendDownloadedMedia(chat, buffer, mimeType, filename, replyTargetId, {
          sendAudioAsVoice: true,
        });
      } catch (error) {
        stopTyping();
        const messageText = error instanceof Error ? error.message : String(error);
        await chat.sendMessage(
          `Errore nella cattura audio: ${messageText}`,
          makeReplyOptions(replyTargetId),
        ).catch(() => undefined);
      }
    });
  }

  async function handleStatus(chat: WhatsAppChat, message: WhatsAppMessage): Promise<void> {
    const senderId = getSenderId(chat, message);
    const sessionKey = getWhatsappSessionKey(chat.id._serialized, senderId, chat.isGroup);
    const alive = sessionManager.isAlive();
    const page = sessionManager.getPage(sessionKey);
    const stored = sessionManager.getStoredSession(sessionKey);

    let geminiStatus = "Non connesso";
    if (alive && page) {
      try {
        geminiStatus = page.isClosed()
          ? "Pagina chiusa"
          : `Connesso (${page.url().split("?")[0]})`;
      } catch {
        geminiStatus = "Errore sessione";
      }
    } else if (alive) {
      geminiStatus = stored
        ? `Sessione salvata — verrà ripristinata su ${stored.conversationId}`
        : "Browser attivo — nessuna tab ancora aperta";
    }

    const convLine = stored
      ? `Conversation: ${stored.conversationId} (${stored.label})`
      : "Conversation: non ancora assegnata";

    const lines = [
      "TeGem Status",
      "",
      `Canale: WhatsApp`,
      `Session key: ${sessionKey}`,
      convLine,
      `Gemini: ${geminiStatus}`,
      `Tab attive: ${sessionManager.sessionCount()}`,
      `Headless: ${process.env.PLAYWRIGHT_HEADLESS === "true" ? "Yes" : "No"}`,
    ];

    await chat.sendMessage(
      lines.join("\n"),
      makeReplyOptions(message.id._serialized),
    ).catch(() => undefined);
  }

  async function handleClear(chat: WhatsAppChat, message: WhatsAppMessage): Promise<void> {
    const senderId = getSenderId(chat, message);
    const sessionKey = getWhatsappSessionKey(chat.id._serialized, senderId, chat.isGroup);

    try {
      await sessionManager.clearSession(provider.config, sessionKey);
      const page = sessionManager.getPage(sessionKey);
      if (page) await provider.ensureReady(page);
      await chat.sendMessage(
        "Conversazione resettata. Nuova sessione avviata!",
        makeReplyOptions(message.id._serialized),
      ).catch(() => undefined);
    } catch {
      await chat.sendMessage(
        "Non sono riuscito a resettare la conversazione. Riprova tra poco.",
        makeReplyOptions(message.id._serialized),
      ).catch(() => undefined);
    }
  }

  async function handleStart(chat: WhatsAppChat, message: WhatsAppMessage): Promise<void> {
    const name = await getSenderName(message);
    const text =
      `Ciao ${name}! Sono TeGem, il tuo assistente AI alimentato da Google Gemini.\n\n` +
      `Puoi scrivermi qualsiasi cosa: rispondo come un assistente AI avanzato.\n\n` +
      `Comandi disponibili:\n` +
      `/help — lista comandi\n` +
      `/clear — nuova conversazione\n` +
      `/status — stato del bot\n` +
      `/q <domanda> — domanda libera, anche su immagini in reply\n` +
      `/vision — descrive l'immagine a cui rispondi\n` +
      `/imagine <descrizione> — genera un'immagine\n` +
      `/music <descrizione> — genera musica\n` +
      `/video <descrizione> — genera un video\n` +
      `/voice — prova a leggere l'ultima risposta`;

    await chat.sendMessage(text, makeReplyOptions(message.id._serialized)).catch(() => undefined);
  }

  async function handleHelp(chat: WhatsAppChat, message: WhatsAppMessage): Promise<void> {
    const text =
      `TeGem — Comandi disponibili\n\n` +
      `/start — messaggio di benvenuto\n` +
      `/help — mostra questa lista\n` +
      `/clear — cancella la cronologia e inizia una nuova conversazione\n` +
      `/status — mostra lo stato del bot e di Gemini\n` +
      `/q <domanda> — domanda libera, anche rispondendo a un'immagine\n` +
      `/vision [prompt] — descrive o analizza l'immagine a cui stai rispondendo\n` +
      `/imagine <descrizione> — genera un'immagine con Gemini\n` +
      `/music <descrizione> — genera musica\n` +
      `/video <descrizione> — genera un video\n` +
      `/voice — prova a catturare l'audio TTS dell'ultima risposta\n\n` +
      `In chat private puoi anche scrivermi liberamente. Nei gruppi rispondo quando mi menzioni.`;

    await chat.sendMessage(text, makeReplyOptions(message.id._serialized)).catch(() => undefined);
  }

  async function handleCommand(
    chat: WhatsAppChat,
    message: WhatsAppMessage,
    command: { name: string; args: string },
  ): Promise<boolean> {
    switch (command.name) {
      case "start":
        await handleStart(chat, message);
        return true;
      case "help":
        await handleHelp(chat, message);
        return true;
      case "clear":
        await handleClear(chat, message);
        return true;
      case "status":
        await handleStatus(chat, message);
        return true;
      case "imagine":
        await handleImagine(chat, message, command.args);
        return true;
      case "music":
        await handleMusic(chat, message, command.args);
        return true;
      case "video":
        await handleVideo(chat, message, command.args);
        return true;
      case "voice":
        await handleVoice(chat, message);
        return true;
      case "q": {
        const quoted = await getQuotedMessageSafe(message);
        const mediaSource = message.hasMedia ? message : (quoted?.hasMedia ? quoted : null);
        if (!command.args && !mediaSource) {
          await chat.sendMessage(
            "Uso: /q <domanda>\nEsempio: /q qual è la capitale della Francia?\n\nPuoi anche allegare un'immagine al comando.",
            makeReplyOptions(message.id._serialized),
          ).catch(() => undefined);
          return true;
        }

        let mediaPath: string | undefined;
        if (mediaSource) {
          mediaPath = (await downloadMessageMediaToTemp(mediaSource)) ?? undefined;
        }

        const prompt = command.args || "Describe this image";
        const replyTargetId = quoted?.id._serialized ?? message.id._serialized;
        await runQuery(chat, message, prompt, replyTargetId, mediaPath);
        return true;
      }
      case "vision": {
        const quoted = await getQuotedMessageSafe(message);
        const mediaSource = quoted?.hasMedia ? quoted : (message.hasMedia ? message : null);
        if (!mediaSource) {
          await chat.sendMessage(
            "Uso: rispondi con /vision a una foto o documento, oppure allega un'immagine insieme a /vision.",
            makeReplyOptions(message.id._serialized),
          ).catch(() => undefined);
          return true;
        }

        const mediaPath = await downloadMessageMediaToTemp(mediaSource);
        if (!mediaPath) {
          await chat.sendMessage(
            "Non sono riuscito a scaricare il file.",
            makeReplyOptions(message.id._serialized),
          ).catch(() => undefined);
          return true;
        }

        const prompt = command.args || "Describe this image in detail.";
        const replyTargetId = quoted?.id._serialized ?? message.id._serialized;
        await runQuery(chat, message, prompt, replyTargetId, mediaPath);
        return true;
      }
      default:
        if (!chat.isGroup) {
          await chat.sendMessage(
            "Comando sconosciuto. Usa /help per vedere i comandi disponibili.",
            makeReplyOptions(message.id._serialized),
          ).catch(() => undefined);
        }
        return false;
    }
  }

  async function handleMediaMessage(chat: WhatsAppChat, message: WhatsAppMessage): Promise<boolean> {
    if (!message.hasMedia) return false;

    const body = getMessageText(message);
    const qPrompt = resolveCaptionQueryCommand(body);

    if (!chat.isGroup) {
      const prompt = qPrompt || body || "Describe this image";
      const mediaPath = await downloadMessageMediaToTemp(message);
      if (!mediaPath) {
        await chat.sendMessage(
          "Non sono riuscito a scaricare il file.",
          makeReplyOptions(message.id._serialized),
        ).catch(() => undefined);
        return true;
      }

      await runQuery(chat, message, prompt, message.id._serialized, mediaPath);
      return true;
    }

    if (qPrompt) {
      const mediaPath = await downloadMessageMediaToTemp(message);
      if (!mediaPath) {
        await chat.sendMessage(
          "Non sono riuscito a scaricare il file.",
          makeReplyOptions(message.id._serialized),
        ).catch(() => undefined);
        return true;
      }

      await runQuery(chat, message, qPrompt, message.id._serialized, mediaPath);
      return true;
    }

    const selfId = client.info?.wid?._serialized;
    if (!selfId || !message.mentionedIds.includes(selfId)) return false;

    const prompt = stripOwnMentions(body, selfId) || "Describe this image";
    const mediaPath = await downloadMessageMediaToTemp(message);
    if (!mediaPath) {
      await chat.sendMessage(
        "Non sono riuscito a scaricare il file.",
        makeReplyOptions(message.id._serialized),
      ).catch(() => undefined);
      return true;
    }

    await runQuery(chat, message, prompt, message.id._serialized, mediaPath);
    return true;
  }

  async function handleIncomingMessage(message: WhatsAppMessage): Promise<void> {
    if (message.fromMe || message.isStatus) return;

    const chat = await message.getChat().catch(() => null);
    if (!chat) return;

    if (!(await ensureAuthorized(chat, message))) return;

    await chat.sendSeen().catch(() => undefined);

    const senderId = getSenderId(chat, message);
    const body = getMessageText(message);
    const command = extractCommand(body);

    if (command) {
      if (!(await enforceRateLimit(chat, senderId, message, command.name))) return;
      await handleCommand(chat, message, command);
      return;
    }

    if (message.hasMedia) {
      const isGroupMention = Boolean(client.info?.wid?._serialized) &&
        message.mentionedIds.includes(client.info.wid._serialized);
      const isRelevantMedia = !chat.isGroup || Boolean(resolveCaptionQueryCommand(body)) || isGroupMention;

      if (!isRelevantMedia) return;
      if (!(await enforceRateLimit(chat, senderId, message))) return;

      const handledMedia = await handleMediaMessage(chat, message);
      if (handledMedia) return;
    }

    if (!body) return;

    if (!chat.isGroup) {
      if (!(await enforceRateLimit(chat, senderId, message))) return;
      await runQuery(chat, message, body, message.id._serialized);
      return;
    }

    const mention = await resolveMentionQuestion(message);
    if (mention.question === null) return;
    if (!(await enforceRateLimit(chat, senderId, message))) return;

    if (!mention.question) {
      await chat.sendMessage(
        "Dimmi pure!",
        makeReplyOptions(message.id._serialized),
      ).catch(() => undefined);
      return;
    }

    await runQuery(chat, message, mention.question, mention.replyTargetId);
  }

  client.on("qr", (qr) => {
    console.log("[TeGem][WhatsApp] QR ricevuto. Scansiona con WhatsApp.");
    qrcodeTerminal.generate(qr, { small: true });
  });

  client.on("code", (code) => {
    console.log(`[TeGem][WhatsApp] Pairing code: ${code}`);
  });

  client.on("authenticated", () => {
    console.log("[TeGem][WhatsApp] Autenticazione completata.");
  });

  client.on("auth_failure", (messageText) => {
    console.error(`[TeGem][WhatsApp] Auth failure: ${messageText}`);
  });

  client.on("change_state", (state) => {
    console.log(`[TeGem][WhatsApp] Stato: ${state}`);
  });

  client.on("disconnected", (reason) => {
    console.warn(`[TeGem][WhatsApp] Disconnesso: ${reason}`);
  });

  client.on("ready", () => {
    const wid = client.info?.wid?._serialized ?? "unknown";
    const name = client.info?.pushname ?? config.whatsapp.deviceName;
    console.log(`[TeGem][WhatsApp] Pronto come ${name} (${wid}).`);
  });

  client.on("message", (message) => {
    void handleIncomingMessage(message).catch((error: unknown) => {
      console.error("[TeGem][WhatsApp] Errore gestione messaggio:", error);
    });
  });

  return {
    async start(): Promise<void> {
      if (started) return;
      started = true;
      console.log("[TeGem][WhatsApp] Avvio client...");
      await client.initialize();
    },
    async stop(): Promise<void> {
      clearInterval(cleanupTimer);
      if (!started) return;
      started = false;
      await client.destroy().catch(() => undefined);
    },
  };
}
