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

  // Auto-login: if a persisted profile exists, open Gemini automatically
  if (await sessionManager.hasPersistedProfile(config.profileDir)) {
    console.log("[TeGem] Profilo Gemini trovato, avvio sessione...");
    try {
      await sessionManager.openForLogin(config.geminiProvider, config.profileDir);
      const page = sessionManager.getPage();
      if (page) {
        await provider.ensureReady(page);
        console.log("[TeGem] Sessione Gemini attiva.");
      }
    } catch (err) {
      console.warn("[TeGem] Auto-login fallito:", err instanceof Error ? err.message : err);
      console.warn("[TeGem] Il bot partirà comunque; la sessione verrà aperta al primo messaggio.");
    }
  } else {
    console.log("[TeGem] Nessun profilo Gemini salvato. Al primo messaggio si aprirà il browser per il login.");
    console.log("[TeGem] Profilo verrà salvato in:", sessionManager.resolveProfilePath(config.profileDir));
  }

  const bot = createBot(config, sessionManager, provider);

  // Set bot commands for Telegram menu
  await bot.api.setMyCommands([
    { command: "start", description: "Messaggio di benvenuto" },
    { command: "help", description: "Lista comandi" },
    { command: "clear", description: "Nuova conversazione" },
    { command: "status", description: "Stato del bot" },
    { command: "imagine", description: "Genera un'immagine" },
  ]);

  console.log("[TeGem] Bot pronto. In ascolto...");

  // Graceful shutdown
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
