import { mkdir } from "node:fs/promises";
import path from "node:path";

import { chromium, type BrowserContext, type Page } from "playwright";

import type { GeminiConfig, GeminiProviderConfig } from "./types.js";

const STEALTH_INIT_SCRIPT = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
`;

export class GeminiSessionManager {
  private context: BrowserContext | null = null;
  private pendingLaunch: Promise<BrowserContext> | null = null;
  /** One page per session key (e.g. "user_123" or "group_-100456"). */
  private pages: Map<string, Page> = new Map();

  constructor(private readonly config: GeminiConfig) {}

  resolveProfilePath(relativeDir: string): string {
    return path.join(
      this.config.baseProfileDir,
      this.config.profileNamespace,
      relativeDir,
    );
  }

  /** Returns the page for the given session key, or null if it doesn't exist / is closed. */
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

  /** Returns the number of active session pages. */
  sessionCount(): number {
    return this.pages.size;
  }

  /**
   * Returns an existing open page for the session key, or creates a new one.
   * All pages share the same browser context (same Google account / cookies).
   */
  async getOrCreate(provider: GeminiProviderConfig, sessionKey: string): Promise<Page> {
    const existing = this.getPage(sessionKey);
    if (existing) return existing;

    const context = await this.ensureContext();
    const page = await context.newPage();

    this.pages.set(sessionKey, page);
    page.on("close", () => this.pages.delete(sessionKey));

    // Navigate to a fresh conversation so each session starts cleanly
    await page.goto(provider.baseUrl, { waitUntil: "domcontentloaded" });

    return page;
  }

  /** Opens a page for manual login. Uses the shared context. */
  async openForLogin(provider: GeminiProviderConfig): Promise<Page> {
    const context = await this.ensureContext();
    // Reuse an existing page if available, otherwise open a new one
    const existing = context.pages().find((p) => !p.isClosed());
    const page = existing ?? await context.newPage();
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
