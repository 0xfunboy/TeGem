import "dotenv/config";

import { loadConfig } from "./config.js";
import { GeminiProvider } from "./gemini/provider.js";
import { GeminiSessionManager } from "./gemini/session.js";
import { createBot } from "./bot/bot.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const sessionManager = new GeminiSessionManager(config.gemini);
  const provider = new GeminiProvider(config.geminiProvider, config.gemini);

  console.log("[TeGem] Avvio bot Telegram...");

  // Warm up the browser context and verify Gemini login
  console.log("[TeGem] Avvio sessione browser...");
  try {
    const loginPage = await sessionManager.openForLogin(config.geminiProvider);
    await provider.ensureReady(loginPage);
    console.log("[TeGem] Sessione Gemini attiva.");
    // Close the warmup page — real pages are created per user/group on demand
    await loginPage.close();
  } catch (err) {
    console.warn("[TeGem] Avvio sessione fallito:", err instanceof Error ? err.message : err);
    console.warn("[TeGem] Il bot partirà comunque; la sessione verrà aperta al primo messaggio.");
  }

  const bot = createBot(config, sessionManager, provider);

  // Set bot commands for Telegram menu
  await bot.api.setMyCommands([
    { command: "start", description: "Welcome message" },
    { command: "help", description: "Command list" },
    { command: "clear", description: "New conversation" },
    { command: "status", description: "Bot status" },
    { command: "q", description: "Ask a question (also works with photos)" },
    { command: "imagine", description: "Generate an image" },
    { command: "music", description: "Generate music" },
    { command: "video", description: "Generate a video" },
    { command: "voice", description: "Read last response (TTS audio)" },
  ]);

  console.log("[TeGem] Bot pronto. In ascolto...");

  const shutdown = async (): Promise<void> => {
    console.log("\n[TeGem] Spegnimento...");
    bot.stop();
    await sessionManager.close();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  bot.start({
    onStart: (info) => console.log(`[TeGem] @${info.username} in ascolto`),
  });
}

main().catch((err) => {
  console.error("[TeGem] Errore fatale:", err);
  process.exit(1);
});
