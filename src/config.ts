import { existsSync } from "node:fs";
import path from "node:path";

import type { GeminiConfig, GeminiProviderConfig } from "./gemini/types.js";

function readBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function readNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveDefaultChromePath(): string | undefined {
  const candidates = ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"];
  return candidates.find((c) => existsSync(c));
}

function resolveProfileNamespace(browserChannel?: string, executablePath?: string): string {
  if (process.env.PLAYWRIGHT_PROFILE_NAMESPACE) return process.env.PLAYWRIGHT_PROFILE_NAMESPACE;
  if (executablePath?.includes("google-chrome")) return "chrome-stable";
  if (browserChannel) return browserChannel;
  return "chromium";
}

export interface AppConfig {
  telegram: {
    token: string;
  };
  gemini: GeminiConfig;
  geminiProvider: GeminiProviderConfig;
  /** Profile directory name relative to baseProfileDir/namespace/ */
  profileDir: string;
  /** System prompt injected into Gemini to give the bot its identity */
  systemPrompt: string;
}

export function loadConfig(): AppConfig {
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!telegramToken) {
    throw new Error("TELEGRAM_BOT_TOKEN non impostato in .env");
  }

  const browserChannel = process.env.PLAYWRIGHT_BROWSER_CHANNEL || undefined;
  const browserExecutablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || resolveDefaultChromePath();

  const geminiConfig: GeminiConfig = {
    headless: readBoolean("PLAYWRIGHT_HEADLESS", false),
    browserChannel,
    browserExecutablePath,
    baseProfileDir: path.resolve(process.cwd(), process.env.PLAYWRIGHT_BASE_PROFILE_DIR ?? ".playwright/profiles"),
    profileNamespace: resolveProfileNamespace(browserChannel, browserExecutablePath),
    streamPollIntervalMs: readNumber("STREAM_POLL_INTERVAL_MS", 700),
    streamStableTicks: readNumber("STREAM_STABLE_TICKS", 4),
    streamFirstChunkTimeoutMs: readNumber("STREAM_FIRST_CHUNK_TIMEOUT_MS", 25_000),
    streamMaxDurationMs: readNumber("STREAM_MAX_DURATION_MS", 90_000),
  };

  const geminiProvider: GeminiProviderConfig = {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://gemini.google.com/app",
    readySelectors: [
      "div[contenteditable='true']",
      "textarea",
      "rich-textarea div[contenteditable='true']",
    ],
    inputSelector: "rich-textarea div[contenteditable='true']",
    submitSelector: "button[aria-label*='Send'], button[aria-label*='Run'], button[aria-label*='Submit'], button[mattooltip*='Send'], button[type='submit']",
    messageSelectors: ["message-content", ".model-response-text", "response-container"],
    busySelectors: ["button[aria-label*='Stop']"],
  };

  const systemPrompt = process.env.SYSTEM_PROMPT || `Sei TeGem, un assistente AI avanzato su Telegram, alimentato da Google Gemini.
Puoi rispondere a domande, generare immagini, aiutare con codice, testi e qualsiasi altra richiesta.

Comandi disponibili del bot:
• /start — messaggio di benvenuto
• /help — mostra questa lista di comandi
• /clear — cancella la cronologia della conversazione e inizia una nuova sessione
• /status — mostra lo stato del bot e di Gemini
• /imagine <descrizione> — genera un'immagine con Gemini (es: /imagine un tramonto sul mare)

Quando l'utente chiede informazioni sui tuoi comandi, spiegali chiaramente.
Rispondi sempre in modo naturale, utile e conciso. Se l'utente scrive in italiano, rispondi in italiano.`;

  return {
    telegram: { token: telegramToken },
    gemini: geminiConfig,
    geminiProvider,
    profileDir: process.env.GEMINI_PROFILE_DIR ?? "_shared",
    systemPrompt,
  };
}
