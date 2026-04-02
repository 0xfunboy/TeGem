import type { CommandContext, Context } from "grammy";

export async function handleHelp(ctx: CommandContext<Context>): Promise<void> {
  await ctx.reply(
    `*TeGem — Comandi disponibili*\n\n` +
    `/start — Messaggio di benvenuto\n` +
    `/help — Mostra questa lista\n` +
    `/clear — Cancella la cronologia e inizia una nuova conversazione\n` +
    `/status — Mostra lo stato del bot e di Gemini\n` +
    `/q <domanda> — Domanda libera, anche rispondendo a un'immagine\n` +
    `/vision — Descrive l'immagine a cui stai rispondendo\n` +
    `/imagine <descrizione> — Genera un'immagine con Gemini\n\n` +
    `Puoi anche scrivermi liberamente: rispondo a qualsiasi domanda, aiuto con codice, testi, analisi e molto altro.`,
    { parse_mode: "Markdown" },
  );
}
