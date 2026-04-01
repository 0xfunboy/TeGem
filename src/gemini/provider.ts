import type { Locator, Page } from "playwright";

import { GeminiQuotaError, GeminiTimeoutError } from "./errors.js";
import type { ConversationSnapshot, GeminiConfig, GeminiProviderConfig, GeminiResponse, GeneratedImage } from "./types.js";

const QUOTA_PATTERNS = [
  /you('ve| have) (reached|exceeded|hit) (your |the )?(daily |usage |message |free )?limit/i,
  /quota (exceeded|limit|reached)/i,
  /rate limit/i,
  /try again (in|after) \d/i,
  /daily usage limit/i,
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GeminiProvider {
  constructor(
    public readonly config: GeminiProviderConfig,
    private readonly geminiConfig: GeminiConfig,
  ) {}

  isQuotaExhausted(text: string): boolean {
    return QUOTA_PATTERNS.some((re) => re.test(text));
  }

  async goto(page: Page): Promise<void> {
    const baseOrigin = new URL(this.config.baseUrl).origin;
    if (!page.url().startsWith(baseOrigin)) {
      await page.goto(this.config.baseUrl, { waitUntil: "domcontentloaded" });
    }
  }

  async ensureReady(page: Page): Promise<void> {
    await this.goto(page);
    const selector = await this.findFirstVisible(page, this.config.readySelectors, 30_000);
    if (!selector) {
      throw new Error("Gemini non pronto. Controlla il login.");
    }
  }

  async isReady(page: Page): Promise<boolean> {
    const selector = await this.findFirstVisible(page, this.config.readySelectors, 1_500);
    return Boolean(selector);
  }

  async ensureConversationNotFull(page: Page, maxMessages = 40): Promise<void> {
    const count = await this.countMessages(page);
    if (count >= maxMessages) {
      await page.goto(this.config.baseUrl, { waitUntil: "domcontentloaded" });
      await this.findFirstVisible(page, this.config.readySelectors, 15_000);
    }
  }

  async snapshotConversation(page: Page): Promise<ConversationSnapshot> {
    const mainText = await this.readMainText(page);
    const imageKeys = await this.listVisibleImageKeys(page);
    const imageNodeCount = await this.countImageNodes(page);

    // Count assistant nodes — this is the PRIMARY baseline signal.
    // readLastMessage will only return content when this count has grown.
    const assistantCount = await this.countAssistantNodes(page);

    if (assistantCount > 0) {
      const providerText = await this.readAssistantText(page);
      return {
        count: assistantCount,
        lastText: this.sanitize(providerText),
        mainText,
        imageKeys,
        imageNodeCount,
      };
    }

    for (const selector of this.config.messageSelectors) {
      const locator = page.locator(selector);
      const count = await locator.count();
      if (count === 0) continue;

      const lastText = this.sanitize(((await locator.last().innerText().catch(() => "")) || "").trim());
      return { count, lastText, mainText, imageKeys, imageNodeCount };
    }

    return { count: 0, lastText: "", mainText, imageKeys, imageNodeCount };
  }

  async sendPrompt(page: Page, prompt: string): Promise<void> {
    await this.ensureReady(page);
    await this.waitUntilIdle(page, 20_000);

    // Wait for Angular to finish replacing DOM elements after page load.
    // We verify the input is STABLE (same element) for two consecutive checks
    // before trusting it with click+type operations.
    const input = await this.waitForStableInput(page, 15_000);
    if (!input) throw new Error("Input Gemini non trovato.");

    await input.click();

    const tagName = await input.evaluate((el) => el.tagName.toLowerCase());
    if (tagName === "textarea" || tagName === "input") {
      await input.fill(prompt);
    } else {
      // Clear via JS so we don't need to select-all
      await input.evaluate((el) => {
        (el as { focus?: () => void; textContent: string | null }).focus?.();
        el.textContent = "";
      });
      // Use locator-scoped pressSequentially / press — safe for parallel pages.
      // page.keyboard.* is global to the browser process and causes keystroke
      // collisions when two tabs are being operated simultaneously.
      const lines = prompt.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) await input.press("Shift+Enter"); // line break, not submit
        if (lines[i]) await input.pressSequentially(lines[i], { delay: 0 });
      }
    }

    // Re-focus in case the rich-textarea lost focus during typing
    await input.click().catch(() => undefined);
    await sleep(80);

    await this.submitPrompt(page);

    await this.ensurePromptSubmitted(page, input, prompt);
  }

  /**
   * Submits the currently typed prompt using multiple strategies in order:
   * 1. Click the send button (re-resolved fresh — never use a potentially stale locator)
   * 2. Press Enter on the contenteditable rich-textarea (element-scoped, safe in parallel)
   * 3. Dispatch a real keyboard Enter event via JS on the focused element (last resort)
   */
  private async submitPrompt(page: Page): Promise<void> {
    // Strategy 1: click the send button (fresh locator, not the input that may be stale)
    if (this.config.submitSelector) {
      const submit = page.locator(this.config.submitSelector).first();
      if (await submit.isVisible({ timeout: 2_000 }).catch(() => false)) {
        try {
          await submit.click({ force: true, timeout: 5_000 });
          return;
        } catch {
          // fall through
        }
      }
    }

    // Strategy 2: Enter on the rich-textarea contenteditable (always fresh locator)
    const contentEditable = page.locator("rich-textarea div[contenteditable='true']").first();
    if (await contentEditable.isVisible({ timeout: 2_000 }).catch(() => false)) {
      try {
        await contentEditable.press("Enter", { timeout: 5_000 });
        return;
      } catch {
        // fall through
      }
    }

    // Strategy 3: dispatch Enter via JS on whatever element currently has focus
    await page.evaluate(() => {
      const el = document.activeElement ?? document.querySelector("[contenteditable='true']");
      if (!el) return;
      for (const type of ["keydown", "keypress", "keyup"] as const) {
        el.dispatchEvent(new KeyboardEvent(type, {
          key: "Enter", code: "Enter", keyCode: 13, which: 13,
          bubbles: true, cancelable: true,
        }));
      }
    }).catch(() => undefined);
  }

  async *streamResponse(
    page: Page,
    baseline: ConversationSnapshot,
    overrides: { maxDurationMs?: number; firstChunkTimeoutMs?: number } = {},
  ): AsyncGenerator<string, GeminiResponse> {
    const maxDurationMs = overrides.maxDurationMs ?? this.geminiConfig.streamMaxDurationMs;
    const firstChunkTimeoutMs = overrides.firstChunkTimeoutMs ?? this.geminiConfig.streamFirstChunkTimeoutMs;
    const startedAt = Date.now();
    let previous = "";
    let stableTicks = 0;
    let firstUsefulSignalSeen = false;

    while (stableTicks < this.geminiConfig.streamStableTicks) {
      if (Date.now() - startedAt > maxDurationMs) {
        throw new GeminiTimeoutError("timeout massimo di risposta superato");
      }

      const current = await this.readLastMessage(page, baseline);
      const hasImageSignal = await this.hasNewImages(page, baseline);

      if (current && current !== previous) {
        const delta = current.startsWith(previous) ? current.slice(previous.length) : "";
        previous = current;
        stableTicks = 0;
        if (delta) {
          firstUsefulSignalSeen = true;
          yield delta;
        }
      }

      if (hasImageSignal) firstUsefulSignalSeen = true;

      const busy = await this.isBusy(page);
      const imageStillLoading = hasImageSignal && !(await this.isImageLoaded(page));
      // Only count stable ticks once we have seen useful content.
      // Before that, only the first-chunk timeout (gated on !busy) applies.
      const canSettle = firstUsefulSignalSeen && !imageStillLoading;
      if (!current || current === previous) {
        if (!canSettle) {
          stableTicks = 0; // haven't started yet — never settle prematurely
        } else {
          stableTicks = busy || imageStillLoading ? 0 : stableTicks + 1;
        }
      }

      // Only fire the first-chunk timeout when Gemini is completely idle —
      // if it's still busy (generating image or text), keep waiting up to maxDurationMs.
      if (!firstUsefulSignalSeen && !busy && Date.now() - startedAt > firstChunkTimeoutMs) {
        throw new GeminiTimeoutError("nessuna risposta entro il timeout iniziale");
      }

      await sleep(this.geminiConfig.streamPollIntervalMs);
    }

    previous = this.extractNewText(
      baseline,
      await this.finalizeMessage(page, baseline, previous, startedAt),
    );
    const images = await this.captureImages(page, baseline);

    if (!previous.trim() && images.length === 0) {
      throw new Error("Gemini non ha prodotto testo utile.");
    }

    return { text: previous, images };
  }

  // ── Private helpers ───────────────────────────────────────

  private async readLastMessage(page: Page, baseline: ConversationSnapshot): Promise<string> {
    // ── Count-based guard: only return content when a NEW assistant node exists ──
    const currentCount = await this.countAssistantNodes(page);
    if (currentCount <= baseline.count) {
      // No new assistant node has appeared — nothing to return regardless of text.
      // This prevents returning the old response when the prompt was never sent.
      return "";
    }

    // A new assistant node exists — read its content.
    const providerText = this.sanitize(await this.readAssistantText(page), baseline.prompt);
    if (providerText) return providerText;

    // Fallback: try messageSelectors (generic container approach)
    for (const selector of this.config.messageSelectors) {
      const locator = page.locator(selector);
      const count = await locator.count();
      if (count === 0 || count <= baseline.count) continue;

      // Read the last node (the new one)
      const node = locator.nth(count - 1);
      const text = this.sanitize((await node.innerText().catch(() => ""))?.trim() ?? "", baseline.prompt);
      if (text) return text;
    }

    return "";
  }

  private async readAssistantText(page: Page): Promise<string> {
    const jsText = await page.evaluate((): string => {
      type DomLike = { querySelectorAll: (s: string) => unknown[] };
      type NodeLike = {
        parentElement?: { closest?: (s: string) => unknown } | null;
        innerText?: string;
      };

      const doc = (globalThis as unknown as { document?: DomLike }).document;
      if (!doc) return "";

      const all = doc.querySelectorAll("message-content") as NodeLike[];
      const topLevel = all.filter((el) => el.parentElement?.closest?.("message-content") === null);
      if (topLevel.length === 0) return "";
      const last = topLevel[topLevel.length - 1];
      return last.innerText?.trim() ?? "";
    }).catch(() => "");

    if (jsText) return jsText;

    return this.readLastVisibleText(page, [
      "response-container message-content",
      ".model-response-text",
      "response-container",
    ]);
  }

  private async countMessages(page: Page): Promise<number> {
    for (const selector of this.config.messageSelectors) {
      const count = await page.locator(selector).count();
      if (count > 0) return count;
    }
    return 0;
  }

  private async countAssistantNodes(page: Page): Promise<number> {
    const count = await page.evaluate((): number => {
      type DomLike = { querySelectorAll: (s: string) => unknown[] };
      type NodeLike = { parentElement?: { closest?: (s: string) => unknown } | null };

      const doc = (globalThis as unknown as { document?: DomLike }).document;
      if (!doc) return 0;

      const all = doc.querySelectorAll("message-content") as NodeLike[];
      return all.filter((el) => el.parentElement?.closest?.("message-content") === null).length;
    }).catch(() => 0);

    if (count > 0) return count;
    return page.locator("response-container").count().catch(() => 0);
  }

  private async readMainText(page: Page): Promise<string> {
    const main = page.locator("main").first();
    const text = (await main.innerText().catch(async () => page.locator("body").innerText().catch(() => ""))) || "";
    return text.trim();
  }

  private async isBusy(page: Page): Promise<boolean> {
    for (const selector of this.config.busySelectors) {
      if (await page.locator(selector).first().isVisible().catch(() => false)) return true;
    }
    return false;
  }

  private async waitUntilIdle(page: Page, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.isBusy(page))) return;
      await sleep(300);
    }
    throw new Error("Gemini occupato; impossibile inviare il prompt.");
  }

  /**
   * Waits until the input element is present AND stable — i.e. the same DOM
   * element is returned on two consecutive checks ~500ms apart.
   * This protects against Angular's hydration cycle replacing the element
   * mid-operation (which causes "element was detached" errors).
   */
  private async waitForStableInput(page: Page, timeoutMs: number): Promise<import("playwright").Locator | null> {
    const selectors = [this.config.inputSelector, ...this.config.readySelectors];
    const deadline = Date.now() + timeoutMs;

    let prevHandle: unknown = null;

    while (Date.now() < deadline) {
      const selector = await this.findFirstVisible(page, selectors, 5_000);
      if (!selector) { await sleep(300); continue; }

      const locator = page.locator(selector).first();
      // Get the underlying JS object handle to compare identity
      const handle = await locator.evaluateHandle((el) => el).catch(() => null);
      if (!handle) { await sleep(300); continue; }

      if (prevHandle !== null) {
        // Compare DOM node identity: same element = stable
        const isSame = await page.evaluate(
          ([a, b]) => a === b,
          [prevHandle, handle] as [unknown, unknown],
        ).catch(() => false);

        await handle.dispose?.().catch(() => undefined);

        if (isSame) return locator; // stable — same element twice in a row
        prevHandle = null; // element changed — reset and wait again
        await sleep(400);
        continue;
      }

      prevHandle = handle;
      await sleep(400);
    }

    return null;
  }

  private async findFirstVisible(page: Page, selectors: string[], timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const selector of selectors) {
        const visible = await page.locator(selector).first().isVisible().catch(() => false);
        if (visible) return selector;
      }
      await sleep(300);
    }
    return null;
  }

  private async firstVisibleLocator(page: Page, selectors: string[], timeoutMs: number): Promise<Locator | null> {
    const selector = await this.findFirstVisible(page, selectors, timeoutMs);
    return selector ? page.locator(selector).first() : null;
  }

  private async ensurePromptSubmitted(page: Page, _input: Locator, prompt: string): Promise<void> {
    const normalizedPrompt = prompt.trim();

    // Re-resolve the input locator each time to avoid stale element references.
    // When the old element is detached, we must check the CURRENT input in the DOM.
    const looksUnsent = async (): Promise<boolean> => {
      // Try the configured input selector first, then fall back to contenteditable
      const freshInput = await this.firstVisibleLocator(
        page,
        [this.config.inputSelector, "rich-textarea div[contenteditable='true']"],
        1_500,
      );
      if (!freshInput) {
        // No visible input at all — could mean Gemini is processing (input hidden
        // while generating). Check if Gemini is busy as a positive signal.
        return false;
      }
      const current = await freshInput
        .evaluate((el) => {
          const f = el as { value?: string; textContent?: string | null; innerText?: string };
          return (f.value || f.innerText || f.textContent || "").trim();
        })
        .catch(() => "");
      // If we got empty string, the input is empty — prompt was likely sent.
      // If we got the prompt text back, it's still sitting there unsent.
      return Boolean(current) && current.includes(normalizedPrompt);
    };

    await sleep(250);
    if (!(await looksUnsent())) return;

    // The prompt is still in the input — try harder to submit it.
    for (const key of ["Control+Enter", "Meta+Enter", "Enter"]) {
      await page.keyboard.press(key).catch(() => undefined);
      await sleep(350);
      if (!(await looksUnsent())) return;
    }

    // Last resort: try submitPrompt strategies again
    await this.submitPrompt(page);
    await sleep(500);
  }

  private async readLastVisibleText(page: Page, selectors: string[]): Promise<string> {
    for (const selector of selectors) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      if (count === 0) continue;

      for (let i = count - 1; i >= 0; i--) {
        const node = locator.nth(i);
        const visible = await node.isVisible().catch(() => false);
        if (!visible) continue;
        const text = ((await node.innerText().catch(() => "")) || "").trim();
        if (text) return text;
      }
    }
    return "";
  }

  private async countImageNodes(page: Page): Promise<number> {
    let total = 0;
    for (const selector of ["generated-image", "single-image", ".generated-images"]) {
      total += await page.locator(selector).count().catch(() => 0);
    }
    return total;
  }

  private async hasNewImages(page: Page, baseline: ConversationSnapshot): Promise<boolean> {
    // Only signal new images if the count of image elements has grown since baseline
    const current = await this.countImageNodes(page);
    if (current <= baseline.imageNodeCount) return false;

    // Also confirm the new element is actually visible and reasonably sized
    for (const selector of ["generated-image", "single-image", ".generated-images"]) {
      const el = page.locator(selector).last();
      if (await el.isVisible().catch(() => false)) {
        const box = await el.boundingBox().catch(() => null);
        if (box && box.width >= 100 && box.height >= 100) return true;
      }
    }
    return false;
  }

  /** Returns true when at least one generated image is fully decoded in the page. */
  private async isImageLoaded(page: Page): Promise<boolean> {
    return page.evaluate((): boolean => {
      const containers = [
        ...Array.from(document.querySelectorAll("generated-image")),
        ...Array.from(document.querySelectorAll("single-image")),
        ...Array.from(document.querySelectorAll(".generated-images")),
      ];

      for (const container of containers) {
        // Light DOM
        const lightImg = container.querySelector("img") as HTMLImageElement | null;
        if (lightImg && lightImg.complete && lightImg.naturalWidth > 0) return true;

        // Shadow DOM
        const shadow = (container as unknown as { shadowRoot?: ShadowRoot }).shadowRoot;
        if (shadow) {
          const shadowImg = shadow.querySelector("img") as HTMLImageElement | null;
          if (shadowImg && shadowImg.complete && shadowImg.naturalWidth > 0) return true;
        }
      }

      // Broad fallback: any img nested in image custom elements
      const allImgs = Array.from(document.querySelectorAll("generated-image img, single-image img")) as HTMLImageElement[];
      return allImgs.some((img) => img.complete && img.naturalWidth > 0);
    }).catch(() => false);
  }

  /** Polls until at least one generated image is fully loaded or timeout expires. */
  async waitForImageReady(page: Page, timeoutMs = 45_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isImageLoaded(page)) return true;
      await sleep(500);
    }
    return false;
  }

  /**
   * Capture generated images by downloading the actual image file via Gemini's
   * download button. Waits until the image is fully loaded before attempting.
   * Never falls back to screenshotting.
   */
  private async captureImages(page: Page, baseline: ConversationSnapshot): Promise<GeneratedImage[]> {
    const hasImage = await this.hasNewImages(page, baseline);
    if (!hasImage) return [];

    // Wait for image to be fully decoded before clicking download
    await this.waitForImageReady(page, 45_000);

    const buf = await this.downloadLastImage(page);
    if (buf) {
      return [{ src: `data:image/jpeg;base64,${buf.toString("base64")}` }];
    }

    return [];
  }

  private async listVisibleImageKeys(page: Page): Promise<string[]> {
    const keys = new Set<string>();
    for (const selector of ["generated-image img[src]", "single-image img[src]", ".generated-images img[src]", ".attachment-container img[src]"]) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const node = locator.nth(i);
        if (!(await node.isVisible().catch(() => false))) continue;
        const box = await node.boundingBox().catch(() => null);
        if (!box || box.width < 100 || box.height < 100) continue;
        const src = await node.evaluate((el) => (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src || "").catch(() => "");
        if (src) keys.add(src);
      }
    }
    return Array.from(keys);
  }

  private async finalizeMessage(
    page: Page,
    baseline: ConversationSnapshot,
    current: string,
    startedAt: number,
  ): Promise<string> {
    let latest = current;
    let stableReads = 0;
    const settleDeadline = Math.min(
      startedAt + this.geminiConfig.streamMaxDurationMs,
      Date.now() + Math.max(this.geminiConfig.streamPollIntervalMs * 4, 2_500),
    );

    while (Date.now() < settleDeadline) {
      const next = await this.readLastMessage(page, baseline);
      if (next && next !== latest) {
        latest = next;
        stableReads = 0;
      } else {
        stableReads += 1;
      }
      const busy = await this.isBusy(page);
      if (!busy && stableReads >= 2) break;
      await sleep(Math.min(this.geminiConfig.streamPollIntervalMs, 700));
    }
    return latest;
  }

  /**
   * Sends the system prompt to Gemini and discards its response.
   * Call this once per fresh conversation to establish the bot's identity.
   */
  async injectSystemPrompt(page: Page, systemPrompt: string): Promise<void> {
    await this.ensureReady(page);
    const baseline = await this.snapshotConversation(page);
    await this.sendPrompt(page, systemPrompt);
    // Drain the generator and discard every chunk
    try {
      const gen = this.streamResponse(page, baseline);
      let n = await gen.next();
      while (!n.done) n = await gen.next();
    } catch {
      // Ignore — we only care that Gemini received the prompt, not what it replied
    }
  }

  /**
   * Hovers over the last generated image, clicks Gemini's download button and
   * intercepts the resulting Playwright download event to obtain the raw bytes.
   * Returns null if no image download can be triggered.
   */
  async downloadLastImage(page: Page): Promise<Buffer | null> {
    // Ensure the image is fully decoded before trying to click the download button
    await this.waitForImageReady(page, 45_000);

    for (const containerSel of ["generated-image", "single-image", ".generated-images"]) {
      const container = page.locator(containerSel).last();
      if (!(await container.isVisible().catch(() => false))) continue;

      // Hover to reveal the action bar buttons
      await container.hover({ force: true }).catch(() => undefined);
      await sleep(700);

      // Strategy 1: direct download icon visible in the action bar
      const directBtn = page
        .locator(".button-icon-wrapper")
        .filter({ has: page.locator('mat-icon[fonticon="download"]') })
        .last();

      if (await directBtn.isVisible().catch(() => false)) {
        const buf = await this.triggerDownload(page, directBtn);
        if (buf) return buf;
      }

      // Strategy 2: open the "⋮" menu → "Download image" menu item
      const moreBtn = page
        .locator('button[aria-label*="More"], button[aria-label*="options"], mat-icon[fonticon="more_vert"]')
        .last();

      if (await moreBtn.isVisible().catch(() => false)) {
        await moreBtn.click({ force: true }).catch(() => undefined);
        await sleep(400);

        const menuItem = page.locator('[data-test-id="image-download-button"]').first();
        if (await menuItem.isVisible().catch(() => false)) {
          const buf = await this.triggerDownload(page, menuItem);
          if (buf) return buf;
        }

        await page.keyboard.press("Escape").catch(() => undefined);
        await sleep(200);
      }
    }

    return null;
  }

  /**
   * Clicks the "⋮" menu on the last response container, then "Listen", and
   * intercepts the audio network response to obtain the raw audio bytes.
   * Returns null if no audio can be captured.
   */
  async downloadLastResponseAudio(page: Page): Promise<Buffer | null> {
    // Register audio interceptor BEFORE opening the menu
    let resolveAudio!: (buf: Buffer | null) => void;
    const audioPromise = new Promise<Buffer | null>((res) => { resolveAudio = res; });
    let cleanedUp = false;

    const responseHandler = async (response: import("playwright").Response): Promise<void> => {
      if (cleanedUp) return;
      const ct = response.headers()["content-type"] ?? "";
      if (ct.startsWith("audio/") || ct.includes("mpeg") || ct.includes("ogg") || ct.includes("wav") || ct.includes("aac")) {
        cleanedUp = true;
        page.off("response", responseHandler);
        try {
          resolveAudio(Buffer.from(await response.body()));
        } catch {
          resolveAudio(null);
        }
      }
    };

    page.on("response", responseHandler);
    const cleanup = (): void => {
      if (!cleanedUp) {
        cleanedUp = true;
        page.off("response", responseHandler);
        resolveAudio(null);
      }
    };

    const timeoutId = setTimeout(cleanup, 20_000);

    try {
      // Click the "⋮" (more options) button on the last response container
      const lastResponse = page.locator("response-container").last();
      const moreBtn = lastResponse
        .locator('button:has(mat-icon[fonticon="more_vert"]), button[aria-label*="More"], button[aria-label*="more"]')
        .first();

      if (!(await moreBtn.isVisible().catch(() => false))) {
        cleanup();
        return null;
      }

      await moreBtn.click({ force: true });
      await sleep(500);

      // Click "Listen"
      const listenBtn = page
        .locator('button[aria-labelledby="tts-label"], button:has(mat-icon[fonticon="volume_up"])')
        .first();

      if (!(await listenBtn.isVisible().catch(() => false))) {
        await page.keyboard.press("Escape").catch(() => undefined);
        cleanup();
        return null;
      }

      await listenBtn.click({ force: true });
      const buf = await audioPromise;
      return buf;
    } catch {
      cleanup();
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async triggerDownload(page: Page, locator: Locator): Promise<Buffer | null> {
    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 20_000 }),
        locator.click({ force: true }),
      ]);
      const filePath = await download.path();
      if (!filePath) return null;
      const { readFile } = await import("node:fs/promises");
      return readFile(filePath);
    } catch {
      return null;
    }
  }

  private extractNewText(baseline: ConversationSnapshot, text: string): string {
    const current = this.sanitize(text, baseline.prompt);
    if (!current) return "";
    if (!baseline.lastText) return current;
    if (current === baseline.lastText) return "";
    if (current.startsWith(baseline.lastText)) {
      const suffix = current.slice(baseline.lastText.length).trim();
      return suffix.length > 0 ? suffix : "";
    }
    return current;
  }

  private sanitize(text: string, prompt?: string): string {
    let cleaned = text.trim();
    if (!cleaned) return "";

    if (prompt) cleaned = cleaned.split(prompt).join(" ").trim();

    const noise = [
      "Gemini isn't human. It can make mistakes, including about people, so double-check it.",
      "Your privacy & Gemini Apps",
      "Opens in a new window",
      "Google may display inaccurate info",
    ];
    for (const marker of noise) cleaned = cleaned.replaceAll(marker, " ");

    cleaned = cleaned.replace(/Gemini Apps Activity[\s\S]*$/i, " ");
    cleaned = cleaned.replace(/^Opens in a new window\s*/i, "");
    // Only strip "Gemini" if it's a standalone line (not part of a sentence)
    cleaned = cleaned.replace(/^Gemini said[:：]\s*/i, "");
    cleaned = cleaned.replace(/^You said[:：]\s*/i, "");
    cleaned = cleaned.replace(/^Caricamento di .*$/gim, " ");
    cleaned = cleaned.replace(/Gemini isn['']t human\.[\s\S]*?double-check it\.\s*/i, "");
    cleaned = cleaned.replace(/Your privacy & Gemini Apps[\s\S]*$/i, " ");
    cleaned = cleaned.replace(/^Ask Gemini 3\s*$/im, "");
    cleaned = cleaned.replace(/^\s*Create image\s*$/gim, "");
    cleaned = cleaned.replace(/^\s*Help me learn\s*$/gim, "");
    cleaned = cleaned.replace(/^\s*Boost my day\s*$/gim, "");

    const noiseLines = new Set(["you said", "gemini said", "tools", "fast", "ask gemini 3"]);

    cleaned = cleaned
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !noiseLines.has(l.toLowerCase()))
      .join("\n")
      .trim();

    return cleaned.replace(/\s{3,}/g, "  ").trim();
  }
}
