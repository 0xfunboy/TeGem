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

      const doc = (globalThis as { document?: DomLike }).document;
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

      const doc = (globalThis as { document?: DomLike }).document;
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

  private async hasNewImages(page: Page, baseline: ConversationSnapshot): Promise<boolean> {
    const seen = new Set(baseline.imageKeys);
    for (const selector of this.getImageSelectors()) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let i = Math.max(0, count - 6); i < count; i++) {
        const node = locator.nth(i);
        const visible = await node.isVisible().catch(() => false);
        if (!visible) continue;
        const box = await node.boundingBox().catch(() => null);
        if (!box || box.width < 120 || box.height < 120) continue;
        const src = await node.evaluate((el) => (el as HTMLImageElement).src || "").catch(() => "");
        if (src && !seen.has(src)) return true;
      }
    }
    return false;
  }

  private async captureImages(page: Page, baseline: ConversationSnapshot): Promise<GeneratedImage[]> {
    const seen = new Set(baseline.imageKeys);
    return page.evaluate(async (): Promise<GeneratedImage[]> => {
      type DomLike = { querySelectorAll: (s: string) => unknown[] };
      type ImgLike = { src?: string; currentSrc?: string; alt?: string; naturalWidth?: number; width?: number; closest?: (s: string) => unknown };
      type NodeLike = { parentElement?: { closest?: (s: string) => unknown } | null; querySelectorAll?: (s: string) => ImgLike[] };

      const toDataSrc = async (src: string): Promise<string> => {
        if (!src || src.startsWith("data:")) return src;
        try {
          const res = await fetch(src, { credentials: "include" });
          if (!res.ok) return src;
          const blob = await res.blob();
          const buf = await blob.arrayBuffer();
          const bytes = Array.from(new Uint8Array(buf));
          return `data:${blob.type || "image/png"};base64,${btoa(bytes.map((v) => String.fromCharCode(v)).join(""))}`;
        } catch { return src; }
      };

      const doc = (globalThis as { document?: DomLike }).document;
      if (!doc) return [];
      const all = Array.from(doc.querySelectorAll("message-content")) as NodeLike[];
      const topLevel = all.filter((el) => el.parentElement?.closest?.("message-content") === null);
      const last = topLevel.at(-1);
      if (!last?.querySelectorAll) return [];

      const candidates = Array.from(last.querySelectorAll("img[src]"))
        .map((img) => ({
          src: img.currentSrc || img.src || "",
          alt: img.alt || "",
          score:
            (img.closest?.(".generated-images, generated-image, single-image, .attachment-container, .image-container") ? 10 : 0) +
            ((img.naturalWidth || img.width || 0) >= 256 ? 5 : 0),
        }))
        .filter((img) => img.src && img.score > 0);

      const deduped = new Set<string>();
      const unique = candidates.filter((img) => {
        if (deduped.has(img.src)) return false;
        deduped.add(img.src);
        return true;
      }).slice(0, 4);

      return Promise.all(unique.map(async (img) => ({ src: await toDataSrc(img.src), alt: img.alt || undefined })));
    }).catch(() => []);
  }

  private getImageSelectors(): string[] {
    return [".generated-images img[src]", "generated-image img[src]", "single-image img[src]", ".attachment-container img[src]"];
  }

  private async listVisibleImageKeys(page: Page): Promise<string[]> {
    const keys = new Set<string>();
    for (const selector of this.getImageSelectors()) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const node = locator.nth(i);
        if (!(await node.isVisible().catch(() => false))) continue;
        const box = await node.boundingBox().catch(() => null);
        if (!box || box.width < 120 || box.height < 120) continue;
        const src = await node.evaluate((el) => (el as HTMLImageElement).src || "").catch(() => "");
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
    cleaned = cleaned.replace(/^Gemini\s*/i, "");
    cleaned = cleaned.replace(/^Gemini said\s*/i, "");
    cleaned = cleaned.replace(/^said\s*/i, "");
    cleaned = cleaned.replace(/^You said\s*/i, "");
    cleaned = cleaned.replace(/^Caricamento di .*$/gim, " ");
    cleaned = cleaned.replace(/Gemini isn['']t human\.[\s\S]*?double-check it\.\s*/i, "");
    cleaned = cleaned.replace(/Your privacy & Gemini[\s\S]*$/i, " ");
    cleaned = cleaned.replace(/^Ask Gemini 3\s*/i, "");
    cleaned = cleaned.replace(/\bCreate image\b/gi, " ");
    cleaned = cleaned.replace(/\bHelp me learn\b/gi, " ");
    cleaned = cleaned.replace(/\bBoost my day\b/gi, " ");

    const noiseLines = new Set(["you said", "gemini", "gemini said", "said", "tools", "fast", "ask gemini 3"]);

    cleaned = cleaned
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !noiseLines.has(l.toLowerCase()))
      .join("\n")
      .trim();

    return cleaned.replace(/\s{3,}/g, "  ").trim();
  }
}
