import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import { chromium, type BrowserContext, type Page } from "playwright";

import type { GeminiConfig, GeminiProviderConfig } from "./types.js";

const STEALTH_INIT_SCRIPT = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
`;

interface GeminiSession {
  profilePath: string;
  context: BrowserContext;
  page: Page;
}

export class GeminiSessionManager {
  private context: BrowserContext | null = null;
  private session: GeminiSession | null = null;
  private pendingLaunch: Promise<BrowserContext> | null = null;

  constructor(private readonly config: GeminiConfig) {}

  resolveProfilePath(relativeDir: string): string {
    return path.join(
      this.config.baseProfileDir,
      this.config.profileNamespace,
      relativeDir,
    );
  }

  async hasPersistedProfile(relativeDir: string): Promise<boolean> {
    try {
      const entries = await readdir(this.resolveProfilePath(relativeDir));
      return entries.length > 0;
    } catch {
      return false;
    }
  }

  isAlive(): boolean {
    if (!this.session) return false;
    if (this.session.page.isClosed()) return false;
    try {
      this.session.context.pages();
      return true;
    } catch {
      return false;
    }
  }

  getPage(): Page | null {
    return this.isAlive() ? this.session!.page : null;
  }

  async getOrCreate(provider: GeminiProviderConfig, profilePath: string): Promise<GeminiSession> {
    if (this.session && this.isAlive()) {
      if (this.session.profilePath === profilePath) return this.session;
      await this.session.page.close().catch(() => undefined);
      this.session = null;
    } else if (this.session) {
      this.session = null;
    }

    const context = await this.ensureContext(profilePath);
    const page = await context.newPage();
    this.session = { profilePath, context, page };

    page.on("close", () => {
      if (this.session?.page === page) this.session = null;
    });

    return this.session;
  }

  async openForLogin(provider: GeminiProviderConfig, relativeDir: string): Promise<Page> {
    const profilePath = this.resolveProfilePath(relativeDir);
    const hadPersisted = await this.hasPersistedProfile(relativeDir);
    const session = await this.getOrCreate(provider, profilePath);
    const targetUrl = hadPersisted ? provider.baseUrl : provider.baseUrl;
    await session.page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    await session.page.bringToFront();
    return session.page;
  }

  async close(): Promise<void> {
    if (this.session) {
      await this.session.page.close().catch(() => undefined);
      this.session = null;
    }
    if (this.context) {
      await this.context.close().catch(() => undefined);
      this.context = null;
    }
  }

  private async ensureContext(profilePath: string): Promise<BrowserContext> {
    if (this.context) {
      try {
        this.context.pages();
        return this.context;
      } catch {
        this.context = null;
      }
    }

    if (this.pendingLaunch) return this.pendingLaunch;

    this.pendingLaunch = this.doLaunch(profilePath);
    try {
      return await this.pendingLaunch;
    } finally {
      this.pendingLaunch = null;
    }
  }

  private async doLaunch(profilePath: string): Promise<BrowserContext> {
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
      this.session = null;
    });

    this.context = context;
    return context;
  }
}
