/**
 * Diagnose: how Gemini handles conversations across tabs and restarts.
 *
 * Tests:
 * 1. Send a message → capture conversation URL
 * 2. Open a second tab, navigate to that URL → verify history is there
 * 3. Open a third tab, send a second message in a NEW conversation
 * 4. Verify tab1 URL ≠ tab3 URL (separate conversations)
 * 5. Close tab2, reopen it, navigate to tab1's URL → verify history still there
 */

import { chromium } from "playwright";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const profilePath = path.join(__dirname, "../.playwright/profiles/chrome-stable/_shared");
const BASE_URL = "https://gemini.google.com/app";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForReady(page: import("playwright").Page, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await page.locator("rich-textarea div[contenteditable='true']").first().isVisible().catch(() => false);
    if (ready) return;
    await sleep(500);
  }
  throw new Error("Gemini input not ready");
}

async function sendMessage(page: import("playwright").Page, text: string): Promise<void> {
  const input = page.locator("rich-textarea div[contenteditable='true']").first();
  await input.click();
  await input.evaluate((el) => { el.textContent = ""; });
  await page.keyboard.type(text);
  await sleep(300);
  const submit = page.locator("button[aria-label*='Send'], button[aria-label*='Run']").first();
  if (await submit.isVisible().catch(() => false)) {
    await submit.click({ force: true });
  } else {
    await page.keyboard.press("Enter");
  }
}

async function waitForResponse(page: import("playwright").Page, timeoutMs = 30_000): Promise<string> {
  // Wait for Stop button to appear (Gemini is generating)
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const busy = await page.locator("button[aria-label*='Stop']").first().isVisible().catch(() => false);
    if (busy) break;
    await sleep(300);
  }
  // Wait for Stop button to disappear (done)
  const deadline2 = Date.now() + timeoutMs;
  while (Date.now() < deadline2) {
    const busy = await page.locator("button[aria-label*='Stop']").first().isVisible().catch(() => false);
    if (!busy) break;
    await sleep(500);
  }
  await sleep(1000);
  return page.url();
}

async function getConversationText(page: import("playwright").Page): Promise<string> {
  return page.evaluate(() => {
    const nodes = document.querySelectorAll("message-content");
    return Array.from(nodes).map((n) => (n as HTMLElement).innerText?.trim() ?? "").join("\n---\n");
  }).catch(() => "");
}

async function main(): Promise<void> {
  console.log("=== TeGem Session Diagnostic ===\n");
  console.log("Profile path:", profilePath);

  if (!existsSync(profilePath)) {
    console.error("ERROR: Profile path does not exist. Run the bot first to create it.");
    process.exit(1);
  }

  const context = await chromium.launchPersistentContext(profilePath, {
    executablePath: "/usr/bin/google-chrome-stable",
    headless: false,
    viewport: { width: 1440, height: 960 },
    locale: "en-US",
    colorScheme: "dark",
    args: ["--window-size=1440,960"],
  });

  try {
    // ── TEST 1: Send a message and capture conversation URL ──────────
    console.log("\n[TEST 1] Send message in new conversation, capture URL");
    const tab1 = await context.newPage();
    await tab1.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    console.log("  tab1 initial URL:", tab1.url());
    await waitForReady(tab1);
    await sendMessage(tab1, "Say only: DIAGNOSTIC_A");
    const urlAfterMsg = await waitForResponse(tab1);
    console.log("  tab1 URL after message:", urlAfterMsg);
    const isConversationUrl = urlAfterMsg !== BASE_URL && urlAfterMsg.includes("/app/");
    console.log("  URL changed from base?", isConversationUrl ? "YES ✓" : "NO ✗");
    const convId = urlAfterMsg.split("/app/")[1]?.split("?")[0] ?? "";
    console.log("  Conversation ID:", convId || "(none — URL did not change)");

    // ── TEST 2: Open second tab, navigate to conversation URL ────────
    console.log("\n[TEST 2] Open tab2, navigate to conversation URL, check history");
    const tab2 = await context.newPage();
    if (convId) {
      await tab2.goto(urlAfterMsg, { waitUntil: "domcontentloaded" });
      await waitForReady(tab2);
      await sleep(2000);
      const history = await getConversationText(tab2);
      console.log("  History visible in tab2?", history.includes("DIAGNOSTIC_A") ? "YES ✓" : `NO ✗ (got: ${history.slice(0, 100)})`);
    } else {
      console.log("  SKIPPED — no conversation URL captured");
    }

    // ── TEST 3: Send a different message in tab1 (same conversation) ─
    console.log("\n[TEST 3] Send second message in tab1 (same conversation)");
    await tab1.bringToFront();
    await waitForReady(tab1);
    await sendMessage(tab1, "Say only: DIAGNOSTIC_B");
    const urlAfterMsg2 = await waitForResponse(tab1);
    console.log("  tab1 URL after 2nd message:", urlAfterMsg2);
    console.log("  URL same as after 1st message?", urlAfterMsg2 === urlAfterMsg ? "YES ✓" : `NO ✗ (was: ${urlAfterMsg})`);

    // ── TEST 4: Create a completely separate conversation in tab3 ────
    console.log("\n[TEST 4] Open tab3, NEW conversation (navigate to base URL)");
    const tab3 = await context.newPage();
    await tab3.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    await waitForReady(tab3);
    await sendMessage(tab3, "Say only: DIAGNOSTIC_C");
    const urlTab3 = await waitForResponse(tab3);
    console.log("  tab3 URL:", urlTab3);
    const convId3 = urlTab3.split("/app/")[1]?.split("?")[0] ?? "";
    console.log("  tab3 conversation ID:", convId3 || "(none)");
    console.log("  Different from tab1?", convId && convId3 && convId !== convId3 ? "YES ✓" : `NO ✗ (tab1: ${convId}, tab3: ${convId3})`);

    // ── TEST 5: Close tab2, reopen it, navigate back to tab1 conv ───
    console.log("\n[TEST 5] Close tab2, reopen, navigate back to tab1 conversation URL");
    await tab2.close();
    const tab2b = await context.newPage();
    if (convId) {
      await tab2b.goto(urlAfterMsg, { waitUntil: "domcontentloaded" });
      await waitForReady(tab2b);
      await sleep(2000);
      const historyAfterReopen = await getConversationText(tab2b);
      const hasBoth = historyAfterReopen.includes("DIAGNOSTIC_A") && historyAfterReopen.includes("DIAGNOSTIC_B");
      console.log("  Both messages visible after reopen?", hasBoth ? "YES ✓" : `NO ✗ (got: ${historyAfterReopen.slice(0, 200)})`);
    } else {
      console.log("  SKIPPED — no conversation URL captured");
    }

    // ── TEST 6: Verify each tab still shows its own conversation ────
    console.log("\n[TEST 6] Verify tab1 and tab3 are on different conversations");
    await tab1.bringToFront();
    const tab1Text = await getConversationText(tab1);
    await tab3.bringToFront();
    const tab3Text = await getConversationText(tab3);
    console.log("  tab1 has DIAGNOSTIC_A:", tab1Text.includes("DIAGNOSTIC_A") ? "YES ✓" : "NO ✗");
    console.log("  tab1 has DIAGNOSTIC_C:", tab1Text.includes("DIAGNOSTIC_C") ? "NO ✓ (isolated)" : "YES ✗ (leaked!)");
    console.log("  tab3 has DIAGNOSTIC_C:", tab3Text.includes("DIAGNOSTIC_C") ? "YES ✓" : "NO ✗");
    console.log("  tab3 has DIAGNOSTIC_A:", tab3Text.includes("DIAGNOSTIC_A") ? "YES ✗ (leaked!)" : "NO ✓ (isolated)");

    // ── SUMMARY ─────────────────────────────────────────────────────
    console.log("\n=== SUMMARY ===");
    console.log("Conversation URL format:", urlAfterMsg);
    console.log("Conversation ID (tab1):", convId);
    console.log("Conversation ID (tab3):", convId3);
    console.log("\nKey findings:");
    console.log("  - URLs change after first message:", isConversationUrl);
    console.log("  - Navigating to conversation URL restores history: (see TEST 2 / TEST 5)");
    console.log("  - Multiple tabs can hold different conversations simultaneously: (see TEST 6)");
    console.log("\nPress Ctrl+C to close the browser.");
    await sleep(60_000);
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
