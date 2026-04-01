import { mkdir } from "node:fs/promises";
import path from "node:path";

import { chromium, type BrowserContext, type Page } from "playwright";

import type { GeminiConfig, GeminiProviderConfig } from "./types.js";
import { ConversationStore, type StoredSession } from "./conversationStore.js";

const STEALTH_INIT_SCRIPT = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
`;

export class GeminiSessionManager {
  private context: BrowserContext | null = null;
  private pendingLaunch: Promise<BrowserContext> | null = null;
  /** One Page per session key. */
  private pages: Map<string, Page> = new Map();
  /** Persistent mapping: sessionKey → conversationId / URL. */
  private store: ConversationStore;
  /**
   * Per-session mutex: maps sessionKey → the tail of the promise chain.
   * Guarantees that only one request runs at a time per session, preventing
   * interleaved keyboard/DOM operations on the same page.
   */
  private locks: Map<string, Promise<void>> = new Map();

  constructor(private readonly config: GeminiConfig) {
    const storeDir = path.join(
      config.baseProfileDir,
      config.profileNamespace,
    );
    this.store = new ConversationStore(storeDir);
  }

  resolveProfilePath(relativeDir: string): string {
    return path.join(
      this.config.baseProfileDir,
      this.config.profileNamespace,
      relativeDir,
    );
  }

  /** Returns the live page for the session key, or null if closed/missing. */
  getPage(sessionKey: string): Page | null {
    const page = this.pages.get(sessionKey);
    if (!page || page.isClosed()) {
      this.pages.delete(sessionKey);
      return null;
    }
    return page;
  }

  /** Returns true if the browser context is alive. */
  isAlive(): boolean {
    if (!this.context) return false;
    try {
      this.context.pages();
      return true;
    } catch {
      return false;
    }
  }

  /** Number of currently open session pages. */
  sessionCount(): number {
    return this.pages.size;
  }

  /**
   * Acquires a per-session lock and runs `fn`. If another call is already
   * running for the same sessionKey, this call waits in a queue.
   * Ensures serial execution per Gemini tab regardless of async concurrency.
   */
  async withLock<T>(sessionKey: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(sessionKey) ?? Promise.resolve();
    let releaseLock!: () => void;
    const next = new Promise<void>((res) => { releaseLock = res; });
    this.locks.set(sessionKey, prev.then(() => next));

    await prev; // wait for any prior request on this session to finish
    try {
      return await fn();
    } finally {
      releaseLock();
      // Clean up if no more waiters
      if (this.locks.get(sessionKey) === next) this.locks.delete(sessionKey);
    }
  }

  /** Returns the stored conversation info for a session key (if any). */
  getStoredSession(sessionKey: string): StoredSession | undefined {
    return this.store.get(sessionKey);
  }

  /**
   * Returns the live page for the session key if it exists, otherwise creates
   * a new browser tab and navigates it to the right place:
   *   - If a conversation was previously stored → navigate to that URL
   *   - Otherwise → navigate to baseUrl to start a fresh conversation
   *
   * After the first message Gemini changes the URL to include the conversation
   * ID. We track that change and persist it automatically.
   */
  async getOrCreate(provider: GeminiProviderConfig, sessionKey: string, label?: string): Promise<Page> {
    const existing = this.getPage(sessionKey);
    if (existing) return existing;

    const context = await this.ensureContext();
    const page = await context.newPage();

    this.pages.set(sessionKey, page);
    page.on("close", () => this.pages.delete(sessionKey));

    // Start URL tracking so we capture the conversation ID after first message
    this.trackConversationUrl(page, sessionKey, label ?? sessionKey, provider.baseUrl);

    const stored = this.store.get(sessionKey);
    if (stored) {
      console.log(`[Session] Restoring ${sessionKey} → ${stored.conversationUrl}`);
      await page.goto(stored.conversationUrl, { waitUntil: "domcontentloaded" });
    } else {
      console.log(`[Session] New session for ${sessionKey}`);
      await page.goto(provider.baseUrl, { waitUntil: "domcontentloaded" });
    }

    return page;
  }

  /**
   * Clears a session: navigates its page to a fresh Gemini conversation and
   * removes the stored conversation ID so a new one will be captured.
   */
  async clearSession(provider: GeminiProviderConfig, sessionKey: string): Promise<void> {
    this.store.delete(sessionKey);
    const page = this.getPage(sessionKey);
    if (page) {
      await page.goto(provider.baseUrl, { waitUntil: "domcontentloaded" });
    }
  }

  /** Opens a temporary page for login verification. Caller should close it when done. */
  async openForLogin(provider: GeminiProviderConfig): Promise<Page> {
    const context = await this.ensureContext();
    const page = await context.newPage();
    await page.goto(provider.baseUrl, { waitUntil: "domcontentloaded" });
    await page.bringToFront();
    return page;
  }

  async close(): Promise<void> {
    for (const page of this.pages.values()) {
      await page.close().catch(() => undefined);
    }
    this.pages.clear();
    if (this.context) {
      await this.context.close().catch(() => undefined);
      this.context = null;
    }
  }

  // ── Private ──────────────────────────────────────────────────────

  /**
   * Listens for URL changes on the page. When Gemini navigates from the base
   * URL to a conversation URL (after the first message), we extract the
   * conversation ID and persist it.
   */
  private trackConversationUrl(
    page: Page,
    sessionKey: string,
    label: string,
    baseUrl: string,
  ): void {
    const handler = (frame: import("playwright").Frame): void => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      // Match: https://gemini.google.com/app/{conversationId}
      const match = url.match(/\/app\/([a-f0-9]{8,})/i);
      if (!match) return;
      const conversationId = match[1];
      const existing = this.store.get(sessionKey);
      if (existing?.conversationId === conversationId) return; // already stored
      const session: StoredSession = {
        conversationId,
        conversationUrl: url,
        label,
        updatedAt: new Date().toISOString(),
      };
      this.store.set(sessionKey, session);
      console.log(`[Session] Stored conversation for ${sessionKey}: ${conversationId}`);
    };

    page.on("framenavigated", handler);
    page.on("close", () => page.off("framenavigated", handler));
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) {
      try {
        this.context.pages();
        return this.context;
      } catch {
        this.context = null;
      }
    }

    if (this.pendingLaunch) return this.pendingLaunch;

    this.pendingLaunch = this.doLaunch();
    try {
      return await this.pendingLaunch;
    } finally {
      this.pendingLaunch = null;
    }
  }

  private async doLaunch(): Promise<BrowserContext> {
    const profilePath = this.resolveProfilePath("_shared");
    await mkdir(profilePath, { recursive: true });

    const context = await chromium.launchPersistentContext(profilePath, {
      channel: this.config.browserExecutablePath ? undefined : (this.config.browserChannel ?? "chrome"),
      executablePath: this.config.browserExecutablePath,
      headless: this.config.headless,
      viewport: { width: 1440, height: 960 },
      locale: "en-US",
      colorScheme: "dark",
      acceptDownloads: true,
      args: [
        "--window-size=1440,960",
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });

    await context.addInitScript(STEALTH_INIT_SCRIPT);

    context.on("close", () => {
      this.context = null;
      this.pages.clear();
    });

    this.context = context;
    return context;
  }
}
