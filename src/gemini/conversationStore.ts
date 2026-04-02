import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface StoredSession {
  conversationId: string;
  conversationUrl: string;
  label: string;
  updatedAt: string;
}

/**
 * Persistent store that maps session keys (e.g. "user_123", "group_-100456")
 * to their Gemini conversation IDs, so conversations survive bot restarts.
 *
 * Stored as a JSON file on disk next to the browser profile.
 */
export class ConversationStore {
  private data: Record<string, StoredSession> = {};
  private filePath: string;

  constructor(baseDir: string) {
    this.filePath = path.join(baseDir, "sessions.json");
    mkdirSync(baseDir, { recursive: true });
    this.load();
  }

  get(sessionKey: string): StoredSession | undefined {
    return this.data[sessionKey];
  }

  findSessionKeyByConversationId(conversationId: string, excludeSessionKey?: string): string | undefined {
    for (const [sessionKey, session] of Object.entries(this.data)) {
      if (sessionKey === excludeSessionKey) continue;
      if (session.conversationId === conversationId) return sessionKey;
    }
    return undefined;
  }

  set(sessionKey: string, session: StoredSession): void {
    this.data[sessionKey] = session;
    this.save();
  }

  delete(sessionKey: string): void {
    delete this.data[sessionKey];
    this.save();
  }

  all(): Record<string, StoredSession> {
    return { ...this.data };
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      this.data = JSON.parse(raw) as Record<string, StoredSession>;
    } catch {
      this.data = {};
    }
  }

  private save(): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf8");
    } catch (err) {
      console.error("[ConversationStore] Failed to save sessions:", err);
    }
  }
}
