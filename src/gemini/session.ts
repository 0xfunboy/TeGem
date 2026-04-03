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
  /** Tracks last activity time per session key for idle eviction. */
  private lastActivity: Map<string, number> = new Map();
  /** Persistent mapping: sessionKey → conversationId / URL. */
  private store: ConversationStore;
  /**
   * Per-session mutex: maps sessionKey → the tail of the promise chain.
   * Guarantees that only one request runs at a time per session, preventing
   * interleaved keyboard/DOM operations on the same page.
   */
  private locks: Map<string, Promise<void>> = new Map();
  /** Eviction interval handle. */
  private evictionTimer: ReturnType<typeof setInterval> | null = null;
  /** Idle timeout in ms. 0 = no eviction. */
  private readonly idleTimeoutMs: number;
  /** Max concurrent tabs. 0 = unlimited. */
  private readonly maxTabs: number;

  constructor(private readonly config: GeminiConfig, idleTimeoutMs = 0, maxTabs = 0) {
    const storeDir = path.join(
      config.baseProfileDir,
      config.profileNamespace,
    );
    this.store = new ConversationStore(storeDir);
    this.idleTimeoutMs = idleTimeoutMs;
    this.maxTabs = maxTabs;

    // Start eviction sweep every 60s if idle timeout is configured
    if (this.idleTimeoutMs > 0) {
      this.evictionTimer = setInterval(() => this.evictIdleSessions(), 60_000);
      this.evictionTimer.unref();
    }
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
    // Touch activity timestamp — this session is actively being used
    this.lastActivity.set(sessionKey, Date.now());
    try {
      return await fn();
    } finally {
      this.lastActivity.set(sessionKey, Date.now());
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
    const duplicateOwner = stored
      ? this.store.findSessionKeyByConversationId(stored.conversationId, sessionKey)
      : undefined;

    if (stored && !duplicateOwner) {
      console.log(`[Session] Restoring ${sessionKey} → ${stored.conversationUrl}`);
      // Use "load" (not just "domcontentloaded") so Angular has time to bootstrap.
      // Then wait for networkidle so hydration XHR calls complete before we return.
      await page.goto(stored.conversationUrl, { waitUntil: "load", timeout: 30_000 });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    } else {
      if (stored && duplicateOwner) {
        console.warn(
          `[Session] Duplicate conversation detected for ${sessionKey} and ${duplicateOwner}; starting a fresh conversation.`,
        );
        this.store.delete(sessionKey);
      }
      console.log(`[Session] New session for ${sessionKey}`);
      await page.goto(provider.baseUrl, { waitUntil: "load", timeout: 30_000 });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
      await this.ensureFreshConversation(page, provider, sessionKey);
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

  /**
   * Evicts idle session tabs. Closes pages that haven't been used for longer
   * than idleTimeoutMs. The conversation mapping in sessions.json is preserved,
   * so the session will be restored seamlessly on the next request.
   * Also enforces maxTabs by evicting least-recently-used sessions.
   */
  private evictIdleSessions(): void {
    const now = Date.now();

    // 1. Evict sessions idle beyond timeout
    if (this.idleTimeoutMs > 0) {
      for (const [sessionKey, lastTs] of this.lastActivity) {
        if (now - lastTs > this.idleTimeoutMs) {
          const page = this.pages.get(sessionKey);
          if (page && !page.isClosed()) {
            console.log(`[Session] Evicting idle tab: ${sessionKey} (idle ${Math.round((now - lastTs) / 1000)}s)`);
            page.close().catch(() => undefined);
          }
          this.pages.delete(sessionKey);
          this.lastActivity.delete(sessionKey);
        }
      }
    }

    // 2. Enforce max tabs by evicting LRU sessions
    if (this.maxTabs > 0 && this.pages.size > this.maxTabs) {
      const sorted = [...this.lastActivity.entries()]
        .filter(([key]) => this.pages.has(key))
        .sort((a, b) => a[1] - b[1]); // oldest first

      const toEvict = sorted.slice(0, this.pages.size - this.maxTabs);
      for (const [sessionKey] of toEvict) {
        const page = this.pages.get(sessionKey);
        if (page && !page.isClosed()) {
          console.log(`[Session] Evicting LRU tab (max tabs ${this.maxTabs}): ${sessionKey}`);
          page.close().catch(() => undefined);
        }
        this.pages.delete(sessionKey);
        this.lastActivity.delete(sessionKey);
      }
    }
  }

  async close(): Promise<void> {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    for (const page of this.pages.values()) {
      await page.close().catch(() => undefined);
    }
    this.pages.clear();
    this.lastActivity.clear();
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
      const duplicateOwner = this.store.findSessionKeyByConversationId(conversationId, sessionKey);
      if (duplicateOwner) {
        console.warn(
          `[Session] Ignoring conversation ${conversationId} for ${sessionKey}; already owned by ${duplicateOwner}.`,
        );
        return;
      }
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

  private async ensureFreshConversation(
    page: Page,
    provider: GeminiProviderConfig,
    sessionKey: string,
  ): Promise<void> {
    const currentConversationId = this.extractConversationId(page.url());
    if (!currentConversationId) return;

    const owner = this.store.findSessionKeyByConversationId(currentConversationId, sessionKey);
    console.warn(
      owner
        ? `[Session] ${sessionKey} landed on ${owner}'s conversation ${currentConversationId}; forcing new chat.`
        : `[Session] ${sessionKey} landed on an existing conversation ${currentConversationId}; forcing new chat.`,
    );

    await this.startNewConversation(page, provider);
  }

  private async startNewConversation(page: Page, provider: GeminiProviderConfig): Promise<void> {
    const currentUrl = page.url();
    const controls = [
      page.locator('button[aria-label*="New chat"]').first(),
      page.locator('a[aria-label*="New chat"]').first(),
      page.locator('button[mattooltip*="New chat"]').first(),
      page.locator('button').filter({ hasText: /new chat|new conversation/i }).first(),
      page.locator('[role="button"]').filter({ hasText: /new chat|new conversation/i }).first(),
      page.locator('button:has(mat-icon[fonticon="add"])').first(),
    ];

    for (const control of controls) {
      if (!(await control.isVisible({ timeout: 1_500 }).catch(() => false))) continue;
      await control.click({ force: true }).catch(() => undefined);

      const changed = await page.waitForURL(
        (url) => {
          const value = String(url);
          return value !== currentUrl || !/\/app\/[a-f0-9]{8,}/i.test(value);
        },
        { timeout: 5_000 },
      ).then(() => true).catch(() => false);
      if (changed) return;

      // Some Gemini layouts clear the page without changing the URL immediately.
      const inputReady = await page.locator(provider.inputSelector).first().isVisible({ timeout: 2_000 }).catch(() => false);
      if (inputReady) return;
    }

    throw new Error("Impossibile creare una nuova conversazione Gemini isolata.");
  }

  private extractConversationId(url: string): string | null {
    const match = url.match(/\/app\/([a-f0-9]{8,})/i);
    return match?.[1] ?? null;
  }
}
