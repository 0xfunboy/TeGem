/**
 * Converts Gemini markdown-style output to Telegram HTML.
 *
 * Telegram HTML supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a href="">.
 * No native bullet lists — we use ▸ as bullet character.
 */

/** Escapes HTML special characters. Must be called BEFORE applying formatting tags. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const TELEGRAM_BIDI_AND_FORMATTING_RE = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/gu;
const TELEGRAM_UNSAFE_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const TELEGRAM_NON_RENDERING_TEXT_RE = /[\p{White_Space}\p{Cc}\p{Cf}]+/gu;

export function sanitizeTelegramDisplayText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(TELEGRAM_BIDI_AND_FORMATTING_RE, "")
    .replace(TELEGRAM_UNSAFE_CONTROL_RE, "");
}

/**
 * Converts Gemini's response text (typically markdown-flavored) to Telegram HTML.
 *
 * Handles:
 *  - Code blocks (```lang ... ```)
 *  - Inline code (`...`)
 *  - Bold (**...**)
 *  - Italic (*...* that aren't bold)
 *  - Strikethrough (~~...~~)
 *  - Headers (# ... → bold)
 *  - Bullet lists (- or * at line start → ▸)
 *  - Numbered lists (preserved as-is)
 *  - Links [text](url)
 */
export function formatForTelegram(text: string): string {
  text = sanitizeTelegramDisplayText(text);

  // ── Step 1: Extract code blocks to protect them from further processing ──
  const codeBlocks: string[] = [];
  let processed = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang: string, code: string) => {
    const escaped = escapeHtml(code.replace(/\n$/, "")); // trim trailing newline
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    const placeholder = `\x00CB${codeBlocks.length}\x00`;
    codeBlocks.push(`<pre><code${langAttr}>${escaped}</code></pre>`);
    return placeholder;
  });

  // ── Step 2: Extract inline code to protect from further processing ──
  const inlineCodes: string[] = [];
  processed = processed.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const placeholder = `\x00IC${inlineCodes.length}\x00`;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return placeholder;
  });

  // ── Step 3: Escape HTML in the remaining text ──
  processed = escapeHtml(processed);

  // ── Step 4: Apply formatting ──

  // Headers: # ... → bold line (## and ### too)
  processed = processed.replace(/^#{1,3}\s+(.+)$/gm, "<b>$1</b>");

  // Bold: **text**
  processed = processed.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // Strikethrough: ~~text~~
  processed = processed.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Italic: *text* (but not inside words like file*.ts)
  // Only match *text* where * is at word boundary
  processed = processed.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, "<i>$1</i>");

  // Links: [text](url)
  processed = processed.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // ── Step 5: Lists ──
  // Bullet lists: lines starting with - or * (followed by space)
  processed = processed.replace(/^[\-\*]\s+/gm, "▸ ");

  // Sub-bullets: lines starting with whitespace then - or *
  processed = processed.replace(/^(\s+)[\-\*]\s+/gm, "$1  ◦ ");

  // ── Step 6: Restore code blocks and inline codes ──
  processed = processed.replace(/\x00CB(\d+)\x00/g, (_match, idx: string) => codeBlocks[Number(idx)]);
  processed = processed.replace(/\x00IC(\d+)\x00/g, (_match, idx: string) => inlineCodes[Number(idx)]);

  return processed.trim();
}

/**
 * Returns true when Telegram can render at least one visible character.
 * Controls such as bidi overrides and zero-width marks are treated as empty.
 */
export function hasVisibleTelegramText(text: string): boolean {
  return sanitizeTelegramDisplayText(text).replace(TELEGRAM_NON_RENDERING_TEXT_RE, "").length > 0;
}

export function describeInvisibleTelegramText(text: string): string {
  const count = Array.from(text).length;
  const noun = count === 1 ? "character" : "characters";
  return `Gemini generated ${count} invisible Unicode ${noun}. Telegram rejects that as an empty message, so the raw output is attached as a text file.`;
}

/** Max Telegram message length. */
export const TELEGRAM_MAX_LEN = 4096;

/**
 * Splits a formatted message into chunks of at most maxLen,
 * breaking at newlines when possible. Preserves open/close tags
 * across splits to avoid broken HTML.
 */
export function splitMessage(text: string, maxLen = TELEGRAM_MAX_LEN): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let breakAt = remaining.lastIndexOf("\n", maxLen);
    if (breakAt <= 0) breakAt = maxLen;
    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).replace(/^\n/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
