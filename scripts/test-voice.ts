/**
 * Smoke test: connects to the RUNNING bot's browser via CDP,
 * clicks "Listen" on the last Gemini response, and logs every
 * network response + DOM audio element.
 *
 * Usage: npx tsx scripts/test-voice.ts
 *
 * Requires: the bot must be running (browser already open).
 */
import "dotenv/config";
import { chromium } from "playwright";
import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";

async function findCdpEndpoint(): Promise<string> {
  // Try common CDP ports
  for (const port of [9222, 9229]) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const data = await res.json() as { webSocketDebuggerUrl: string };
        return data.webSocketDebuggerUrl;
      }
    } catch { /* try next */ }
  }
  throw new Error("No CDP endpoint found. Make sure the bot is running with --remote-debugging-port.");
}

async function main() {
  // Since we can't connect to the persistent context directly,
  // we'll modify the approach: use the bot's own page via the session manager.
  // Instead, let's just inspect the current page by connecting to CDP.

  // Alternative approach: just look at the running browser's debug port
  // The bot doesn't expose CDP. Let's take a different approach —
  // temporarily stop the bot, run our test, then restart.

  console.log("[test-voice] The bot is using the browser profile.");
  console.log("[test-voice] Please STOP the bot first (Ctrl+C), then re-run this script.");
  console.log("[test-voice] Or we can add a diagnostic endpoint to the bot.\n");

  // Alternative: launch a SEPARATE profile just for testing
  console.log("[test-voice] Launching with a TEMPORARY profile instead...");
  console.log("[test-voice] You will need to log into Google in this browser.\n");

  const tmpProfile = path.resolve(process.cwd(), ".playwright/profiles/test-voice-tmp");
  await mkdir(tmpProfile, { recursive: true });

  const context = await chromium.launchPersistentContext(tmpProfile, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1440, height: 960 },
    acceptDownloads: true,
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run"],
  });

  const page = await context.newPage();
  await page.goto("https://gemini.google.com/app", { waitUntil: "load" });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});

  console.log("[test-voice] Page loaded:", page.url());
  console.log("[test-voice] If you need to log in, do it now in the browser.");
  console.log("[test-voice] Then send a message to Gemini and press Enter here when ready.\n");

  // Wait for user to be ready
  await new Promise<void>((resolve) => {
    process.stdin.once("data", () => resolve());
    // Auto-continue after 120s
    setTimeout(resolve, 120_000);
  });

  await runVoiceTest(page);

  console.log("\n[test-voice] Done. Browser left open for inspection. Ctrl+C to exit.");
  await new Promise(() => {});
}

async function runVoiceTest(page: import("playwright").Page) {
  console.log("[test-voice] Starting voice test...\n");

  // ── Log ALL network responses ──
  const allResponses: Array<{ url: string; ct: string; size: number; status: number }> = [];

  page.on("response", async (response) => {
    const ct = response.headers()["content-type"] ?? "";
    const url = response.url();
    const status = response.status();

    // Log everything interesting
    const isAudioRelated =
      ct.startsWith("audio/") ||
      ct.includes("mpeg") ||
      ct.includes("ogg") ||
      ct.includes("wav") ||
      ct.includes("webm") ||
      ct.includes("opus") ||
      ct.includes("octet-stream") ||
      url.includes("tts") ||
      url.includes("audio") ||
      url.includes("speech") ||
      url.includes("voice") ||
      url.includes("synthesize") ||
      url.includes("batchexecute"); // Gemini RPC endpoint

    if (isAudioRelated) {
      try {
        const body = await response.body();
        const entry = { url: url.slice(0, 250), ct, size: body.length, status };
        allResponses.push(entry);
        console.log(`[NET] ${status} ${ct} (${body.length}b) ${url.slice(0, 150)}`);

        // Save audio files
        if (body.length > 5000 && (ct.startsWith("audio/") || ct.includes("mpeg") || ct.includes("ogg") || ct.includes("octet-stream"))) {
          const outDir = path.resolve(process.cwd(), "scripts/test-output");
          await mkdir(outDir, { recursive: true });
          const ext = ct.includes("mpeg") ? "mp3" : ct.includes("ogg") ? "ogg" : "bin";
          const outFile = path.join(outDir, `tts-${Date.now()}.${ext}`);
          await writeFile(outFile, body);
          console.log(`  → SAVED ${outFile}`);
        }
      } catch {
        console.log(`[NET] ${status} ${ct} (body unavailable) ${url.slice(0, 150)}`);
      }
    }
  });

  // ── Monitor DOM for <audio> elements ──
  const audioCheckInterval = setInterval(async () => {
    try {
      const info = await page.evaluate(() => {
        const results: string[] = [];
        document.querySelectorAll("audio").forEach((a, i) => {
          results.push(`audio[${i}] src="${a.src.slice(0, 100)}" currentSrc="${a.currentSrc.slice(0, 100)}" paused=${a.paused} readyState=${a.readyState} duration=${a.duration}`);
          // Check source children
          a.querySelectorAll("source").forEach((s, j) => {
            results.push(`  source[${j}] src="${s.src.slice(0, 100)}" type="${s.type}"`);
          });
        });
        document.querySelectorAll("video").forEach((v, i) => {
          results.push(`video[${i}] src="${v.src.slice(0, 100)}" currentSrc="${v.currentSrc.slice(0, 100)}" paused=${v.paused}`);
        });
        return results;
      });
      if (info.length > 0) {
        console.log("[DOM]", info.join("\n      "));
      }
    } catch { /* page closed */ }
  }, 2000);

  // ── Step 1: find last response ──
  const lastResponse = page.locator("response-container").last();
  if (!(await lastResponse.isVisible({ timeout: 5_000 }).catch(() => false))) {
    console.error("[test-voice] No response-container visible! Send a message first.");
    clearInterval(audioCheckInterval);
    return;
  }
  console.log("[test-voice] Found last response-container.");

  // ── Step 2: hover to reveal action bar ──
  await lastResponse.hover({ force: true });
  await sleep(500);

  // ── Step 3: find ⋮ button ──
  // Try scoped first, then page-wide
  const moreBtnCandidates = [
    lastResponse.locator('button:has(mat-icon[fonticon="more_vert"])').first(),
    page.locator('button:has(mat-icon[fonticon="more_vert"])').last(),
  ];

  let moreBtn = null;
  for (const candidate of moreBtnCandidates) {
    if (await candidate.isVisible({ timeout: 2_000 }).catch(() => false)) {
      moreBtn = candidate;
      break;
    }
  }

  if (!moreBtn) {
    console.error("[test-voice] ⋮ button not found!");
    clearInterval(audioCheckInterval);
    return;
  }
  console.log("[test-voice] Clicking ⋮ button...");
  await moreBtn.click({ force: true });
  await sleep(800);

  // ── Step 4: list menu items ──
  const menuItems = page.locator("button.mat-mdc-menu-item, button[mat-menu-item]");
  const menuCount = await menuItems.count();
  console.log(`[test-voice] Menu has ${menuCount} items:`);
  for (let i = 0; i < menuCount; i++) {
    const item = menuItems.nth(i);
    const text = await item.innerText().catch(() => "?");
    const icon = await item.locator("mat-icon").first().getAttribute("fonticon").catch(() => "?");
    const ariaLabelledby = await item.getAttribute("aria-labelledby").catch(() => "?");
    console.log(`  [${i}] icon=${icon} ariaLabelledby=${ariaLabelledby} text="${text.trim().replace(/\n/g, " ")}"`);
  }

  // ── Step 5: click Listen ──
  const listenCandidates = [
    page.locator('button[aria-labelledby="tts-label"]').first(),
    page.locator('button:has(mat-icon[fonticon="volume_up"])').first(),
    page.locator('button.mat-mdc-menu-item').filter({ hasText: /listen/i }).first(),
  ];

  let listenBtn = null;
  for (const candidate of listenCandidates) {
    if (await candidate.isVisible({ timeout: 2_000 }).catch(() => false)) {
      listenBtn = candidate;
      break;
    }
  }

  if (!listenBtn) {
    console.error("[test-voice] Listen button NOT FOUND!");
    await page.keyboard.press("Escape");
    clearInterval(audioCheckInterval);
    return;
  }

  console.log("[test-voice] Clicking Listen...");
  await listenBtn.click({ force: true });

  // ── Step 6: wait and observe for 45s ──
  console.log("[test-voice] Observing for 45 seconds...\n");
  await sleep(45_000);

  // ── Summary ──
  clearInterval(audioCheckInterval);
  console.log("\n=== SUMMARY ===");
  console.log(`Network responses captured: ${allResponses.length}`);
  for (const r of allResponses) {
    console.log(`  ${r.status} ${r.ct} (${r.size}b) ${r.url}`);
  }

  // Final DOM check
  const finalDom = await page.evaluate(() => {
    const results: string[] = [];
    document.querySelectorAll("audio").forEach((a) => {
      results.push(`audio src="${a.src}" duration=${a.duration} paused=${a.paused}`);
    });
    // Check for any blob URLs in the page
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const el = node as Element;
      const src = el.getAttribute("src") ?? "";
      if (src.startsWith("blob:")) {
        results.push(`blob-src on <${el.tagName.toLowerCase()}>: ${src}`);
      }
    }
    return results;
  }).catch(() => []);

  if (finalDom.length > 0) {
    console.log("\nFinal DOM state:");
    for (const line of finalDom) console.log(`  ${line}`);
  }

  if (allResponses.length === 0) {
    console.log("\n⚠ No audio network traffic detected.");
    console.log("Gemini TTS likely uses:");
    console.log("  - Web Audio API (AudioContext + decodeAudioData)");
    console.log("  - MediaSource Extensions (MSE)");
    console.log("  - Or the audio data is embedded in a batchexecute RPC response");
    console.log("\nNext steps: intercept batchexecute responses or hook AudioContext.");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch(console.error);
