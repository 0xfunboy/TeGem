import type { CommandContext, Context } from "grammy";

export async function handleStart(ctx: CommandContext<Context>): Promise<void> {
  const name = ctx.from?.first_name ?? "utente";
  await ctx.reply(
    `Ciao ${name}! Sono *TeGem*, il tuo assistente AI alimentato da Google Gemini.\n\n` +
    `Puoi scrivermi qualsiasi cosa — rispondo come un assistente AI avanzato.\n\n` +
    `*Comandi disponibili:*\n` +
    `/help — lista comandi\n` +
    `/clear — nuova conversazione\n` +
    `/status — stato del bot\n` +
    `/imagine <descrizione> — genera un'immagine`,
    { parse_mode: "Markdown" },
  );
}
