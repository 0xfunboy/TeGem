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
    const providerText = await this.readAssistantText(page);

    if (providerText) {
      return {
        count: await this.countAssistantNodes(page),
        lastText: providerText,
        mainText,
        imageKeys,
      };
    }

    for (const selector of this.config.messageSelectors) {
      const locator = page.locator(selector);
      const count = await locator.count();
      if (count === 0) continue;

      const lastText = this.sanitize(((await locator.last().innerText().catch(() => "")) || "").trim());
      return { count, lastText, mainText, imageKeys };
    }

    return { count: 0, lastText: "", mainText, imageKeys };
  }

  async sendPrompt(page: Page, prompt: string): Promise<void> {
    await this.ensureReady(page);
    await this.waitUntilIdle(page, 20_000);

    const input = await this.firstVisibleLocator(page, [this.config.inputSelector, ...this.config.readySelectors], 10_000);
    if (!input) throw new Error("Input Gemini non trovato.");

    await input.click();

    const tagName = await input.evaluate((el) => el.tagName.toLowerCase());
    if (tagName === "textarea" || tagName === "input") {
      await input.fill(prompt);
    } else {
      await input.evaluate((el) => {
        (el as { focus?: () => void; textContent: string | null }).focus?.();
        el.textContent = "";
      });
      await page.keyboard.type(prompt);
    }

    let submitted = false;

    if (this.config.submitSelector) {
      const submit = page.locator(this.config.submitSelector).first();
      if (await submit.isVisible().catch(() => false)) {
        await submit.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
        await page.keyboard.press("Escape").catch(() => undefined);
        await sleep(150);
        await submit.click({ force: true }).catch(async () => {
          await input.press("Enter").catch(async () => {
            await page.keyboard.press("Enter");
          });
        });
        submitted = true;
      }
    }

    if (!submitted) {
      await input.press("Enter").catch(async () => {
        await page.keyboard.press("Enter");
      });
    }

    await this.ensurePromptSubmitted(page, input, prompt);
  }

  async *streamResponse(
    page: Page,
    baseline: ConversationSnapshot,
  ): AsyncGenerator<string, GeminiResponse> {
    const startedAt = Date.now();
    let previous = "";
    let stableTicks = 0;
    let firstUsefulSignalSeen = false;

    while (stableTicks < this.geminiConfig.streamStableTicks) {
      if (Date.now() - startedAt > this.geminiConfig.streamMaxDurationMs) {
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
      // Gemini può stabilizzarsi anche mentre è ancora "busy" dopo il primo chunk
      const canSettleWhileBusy = firstUsefulSignalSeen;
      if (!current || current === previous) {
        stableTicks = busy && !canSettleWhileBusy ? 0 : stableTicks + 1;
      }

      if (!firstUsefulSignalSeen && Date.now() - startedAt > this.geminiConfig.streamFirstChunkTimeoutMs) {
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
    const providerText = this.sanitize(await this.readAssistantText(page), baseline.prompt);
    if (providerText && providerText !== baseline.lastText) {
      if (baseline.lastText && providerText.startsWith(baseline.lastText)) {
        const newContent = providerText.slice(baseline.lastText.length).trim();
        if (newContent.length > 5) return newContent;
        return "";
      }
      return providerText;
    }

    for (const selector of this.config.messageSelectors) {
      const locator = page.locator(selector);
      const count = await locator.count();
      if (count === 0) continue;

      const index = Math.max(count - 1, baseline.count > 0 ? baseline.count : count - 1);
      const node = locator.nth(index >= count ? count - 1 : index);
      const text = this.sanitize((await node.innerText().catch(() => ""))?.trim() ?? "", baseline.prompt);
      if (!text) continue;
      if (count === baseline.count && text === baseline.lastText) continue;
      if (count > baseline.count && text === baseline.lastText) continue;
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

  private async ensurePromptSubmitted(page: Page, input: Locator, prompt: string): Promise<void> {
    const normalizedPrompt = prompt.trim();
    const looksUnsent = async (): Promise<boolean> => {
      const current = await input
        .evaluate((el) => {
          const f = el as { value?: string; textContent?: string | null; innerText?: string };
          return (f.value || f.innerText || f.textContent || "").trim();
        })
        .catch(() => "");
      return Boolean(current) && current.includes(normalizedPrompt);
    };

    await sleep(250);
    if (!(await looksUnsent())) return;

    for (const key of ["Control+Enter", "Meta+Enter", "Enter"]) {
      await page.keyboard.press(key).catch(() => undefined);
      await sleep(350);
      if (!(await looksUnsent())) return;
    }
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

  private async hasNewImages(page: Page, _baseline: ConversationSnapshot): Promise<boolean> {
    // Primary: check for Gemini image-generation custom elements (visible + reasonably sized)
    for (const selector of ["generated-image", "single-image", ".generated-images"]) {
      const el = page.locator(selector).last();
      if (await el.isVisible().catch(() => false)) {
        const box = await el.boundingBox().catch(() => null);
        if (box && box.width >= 100 && box.height >= 100) return true;
      }
    }
    return false;
  }

  /**
   * Capture generated images using Playwright's locator.screenshot() which
   * works across Shadow DOM boundaries. Falls back to screenshotting the
   * entire last response container if no specific image elements are found.
   */
  private async captureImages(page: Page, baseline: ConversationSnapshot): Promise<GeneratedImage[]> {
    const seen = new Set(baseline.imageKeys);
    const results: GeneratedImage[] = [];

    // Priority order: custom elements first (shadow-DOM-safe via locator.screenshot),
    // then CSS-reachable img elements.
    const candidates = [
      "generated-image",
      "single-image",
      ".generated-images",
      "generated-image img[src]",
      "single-image img[src]",
      ".generated-images img[src]",
      ".attachment-container img[src]",
    ];

    for (const selector of candidates) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      if (count === 0) continue;

      for (let i = Math.max(0, count - 4); i < count; i++) {
        if (results.length >= 4) return results;

        const node = locator.nth(i);
        if (!(await node.isVisible().catch(() => false))) continue;

        const box = await node.boundingBox().catch(() => null);
        if (!box || box.width < 100 || box.height < 100) continue;

        // Build a dedup key from the img src if available (works even through shadow DOM
        // because we query the light DOM src attribute on the outer element's child)
        const src = await node.evaluate((el) => {
          const img = el.tagName === "IMG" ? el : el.querySelector("img");
          return (img as HTMLImageElement | null)?.currentSrc || (img as HTMLImageElement | null)?.src || "";
        }).catch(() => "");

        const dedupeKey = src || `${selector}:${i}:${Math.round(box.width)}x${Math.round(box.height)}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        // locator.screenshot() renders the element as-is, bypassing any shadow DOM limitation
        const shot = await node.screenshot({ type: "png" }).catch(() => null);
        if (!shot) continue;

        const alt = await node.evaluate((el) => {
          const img = el.tagName === "IMG" ? el : el.querySelector("img");
          return (img as HTMLImageElement | null)?.alt || "";
        }).catch(() => "");

        results.push({ src: `data:image/png;base64,${shot.toString("base64")}`, alt: alt || undefined });
      }

      if (results.length > 0) break; // found images at this selector level, stop
    }

    if (results.length > 0) return results;

    // Last resort: screenshot the whole last response container
    return this.screenshotLastResponse(page);
  }

  /** Screenshot the last visible response container as a fallback image capture. */
  async screenshotLastResponse(page: Page): Promise<GeneratedImage[]> {
    for (const selector of ["response-container", "message-content", ".presented-response-container"]) {
      const locator = page.locator(selector).last();
      if (!(await locator.isVisible().catch(() => false))) continue;
      const box = await locator.boundingBox().catch(() => null);
      if (!box || box.width < 100 || box.height < 100) continue;
      const shot = await locator.screenshot({ type: "png" }).catch(() => null);
      if (shot) return [{ src: `data:image/png;base64,${shot.toString("base64")}` }];
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
