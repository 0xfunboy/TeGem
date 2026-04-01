# TeGem — Handoff Document

**Project**: TeGem — Telegram bot powered by Google Gemini via Playwright browser automation  
**Repo**: https://github.com/0xfunboy/TeGem  
**Stack**: TypeScript, Node.js, grammy (Telegram), Playwright (Chrome automation)  
**Last commit**: `06a0ea7`

---

## General Objective

Build a Telegram bot that uses the **Gemini web UI** (gemini.google.com) as its LLM backend via Playwright browser automation — not the API. One persistent Chrome profile holds the Google login. The bot supports:

- Private DM conversations (one Gemini chat per user)
- Group conversations (one Gemini chat per user per group)
- Image generation via `/imagine`
- `@mention` in groups with reply-context forwarding
- `/q` for natural-language queries in groups
- Per-user/group conversation persistence across bot restarts

---

## Architecture

```
Telegram user → grammy bot → GeminiSessionManager → Playwright Page → gemini.google.com
                                     ↓
                              ConversationStore (sessions.json)
                              maps sessionKey → Gemini conversation URL
```

### Session keys
- Private DM: `user_{telegramUserId}`
- Group: `group_{chatId}_user_{userId}` (one conversation per user per group)

### Session persistence
After the first message, Gemini navigates to `gemini.google.com/app/{conversationId}`. A `framenavigated` listener captures this URL and writes it to `sessions.json` in the browser profile directory. On bot restart, the session is restored by navigating directly to that URL.

### Concurrency
- One Playwright `Page` (browser tab) per session key
- All pages share one `BrowserContext` (one Chrome profile = one Google account)
- Per-session mutex (`withLock`) serializes requests within the same session
- Different sessions run fully in parallel

---

## Key Files

| File | Purpose |
|---|---|
| `src/gemini/session.ts` | Browser lifecycle, page-per-session, mutex, conversation URL tracking |
| `src/gemini/provider.ts` | All Gemini DOM automation: send, stream, snapshot, image download |
| `src/gemini/conversationStore.ts` | JSON persistence of sessionKey → conversationUrl |
| `src/bot/bot.ts` | grammy bot, message routing, `runQuery` helper |
| `src/bot/sessionKey.ts` | `getSessionKey()` and `getSessionLabel()` |
| `src/bot/middleware/auth.ts` | Whitelist by user ID / group chat ID |
| `src/bot/commands/imagine.ts` | `/imagine` command with 2× timeout |
| `src/bot/commands/clear.ts` | `/clear` — resets session, deletes stored URL |
| `src/bot/commands/voice.ts` | `/voice` — TTS audio via network intercept (broken, see below) |
| `src/config.ts` | `.env` → `AppConfig` |
| `.env` | `TELEGRAM_BOT_TOKEN`, `ALLOWED_USERS`, `ALLOWED_GROUPS`, timeouts |

---

## What Works

- ✅ Text conversations in DM and groups
- ✅ `@mention` in groups with reply-context: "contesta questo di funboy:\n\nIl sole è verde"
- ✅ `/q` command for groups
- ✅ `/imagine` with image download via Gemini's download button
- ✅ Auth whitelist (ALLOWED_USERS, ALLOWED_GROUPS comma-separated IDs)
- ✅ Per-user/group session isolation with persistent Gemini conversation URLs
- ✅ Conversation restore on bot restart (navigate to saved URL)
- ✅ Parallel-safe input via `locator.pressSequentially()` (not global keyboard)
- ✅ Count-based response detection (no longer text-comparison-based)
- ✅ Image generation state awareness (`waitForImageReady` polls `img.naturalWidth`)
- ✅ `acceptDownloads: true` in browser context for actual file download

---

## Outstanding Problems

### 1. Session restore — Angular hydration race (partially fixed)

**Status**: Latest fix adds `networkidle` wait + `waitForStableInput()` (stable DOM identity check). Not yet tested in production.

**Symptom**: After navigating to a saved conversation URL, Angular's hydration cycle replaces the `textarea`/`contenteditable` input elements. If `sendPrompt` starts before hydration completes, the element gets detached mid-operation. The message is never sent, but `streamResponse` reads the existing conversation and returns the old response as if it were new.

**Fix applied**: 
- `session.ts`: `waitUntil: "load"` + `waitForLoadState("networkidle")` before returning the page
- `provider.ts`: `waitForStableInput()` — verifies the same DOM node appears on two consecutive checks ~400ms apart before typing

**Risk**: `networkidle` can be slow or never fire on Gemini's SPA. May need a fallback timeout (already `.catch(() => undefined)`).

### 2. Response offset (mostly fixed, not 100% confirmed)

**Root cause**: Three bugs that Opus diagnosed:
1. Sanitize mismatch between `snapshotConversation` (no prompt) and `readLastMessage` (with prompt) — **fixed** by count-based guard
2. Stale `input` locator in `ensurePromptSubmitted` → declared "sent" when it wasn't — **fixed** by re-resolving locator on each check
3. No structural guard — `readLastMessage` could return old content — **fixed**: now only returns content when `currentCount > baseline.count`

**Remaining risk**: If `countAssistantNodes` is unreliable (Angular renders nodes late, or uses virtual DOM), the count-based guard could still have false positives. The selector used is `message-content` (Angular custom element).

### 3. `/voice` TTS audio (not working)

**Status**: Code written, never confirmed working.

**Implementation**: Opens the `⋮` menu on the last `response-container`, clicks "Listen" (`aria-labelledby="tts-label"`), intercepts `audio/*` network response.

**Problem**: The menu click may not work reliably via Playwright (Angular Material menus often require hover state). Audio intercept via `page.on("response")` may race with the actual request. Never observed to successfully capture audio.

### 4. Image download reliability

**Status**: Works in most cases. Known failure modes:
- The download button hover reveal requires the `generated-image` container to be fully in view and hovered. Can fail if the element is off-screen.
- `waitForImageReady` polls `img.naturalWidth > 0` in light + shadow DOM but Gemini Pro uses a different image rendering path sometimes.
- Fallback: if `downloadLastImage` returns null, `captureImages` returns empty array → user gets "non ha generato immagini" even if an image is visible.

### 5. Multi-tab resource usage

Each active session holds one Chrome tab open indefinitely. With many users, memory grows unboundedly. No tab eviction/LRU implemented.

---

## Pending Feature Requests

1. **`/voice` fix** — Make TTS audio capture reliable. Alternative approach: use `page.route` to intercept before request completes, or find the audio URL in the page DOM.

2. **Markdown rendering** — Gemini responses contain markdown (bold, lists, code blocks). Telegram supports `parse_mode: "MarkdownV2"` but the raw text from `innerText` contains plain text with no markdown. Need to extract formatted text from the DOM or convert `innerHTML` to Telegram-flavored markdown.

3. **Session eviction** — Close tabs that haven't been used in N hours to save memory. Keep the `sessions.json` entry so the conversation can be restored on next message.

4. **`/sessions` admin command** — List all active sessions with their keys, labels, conversation IDs, and last-used timestamps.

5. **Video generation** — Gemini now supports video generation. Similar flow to images but with longer wait times and different DOM selectors.

---

## DOM Selectors Reference

Gemini uses Angular custom elements. Key selectors:

| What | Selector |
|---|---|
| Input (rich textarea) | `rich-textarea div[contenteditable='true']` |
| Submit button | `button[aria-label*='Send']`, `button[mattooltip*='Send']` |
| Assistant message text | `message-content` (Angular CE, top-level only) |
| Response container | `response-container` |
| Busy indicator (generating) | `button[aria-label*='Stop']` |
| Generated image | `generated-image`, `single-image` |
| Download button | `button:has(mat-icon[fonticon="download"])` |
| More options menu | `button:has(mat-icon[fonticon="more_vert"])` |
| TTS listen button | `button[aria-labelledby="tts-label"]` |

**Shadow DOM**: `generated-image` and `single-image` use Angular's view encapsulation. `img` elements inside may be in shadow DOM. `locator.screenshot()` bypasses this; `querySelector` does not.

---

## Known Gemini UI Behaviors

- URL changes from `gemini.google.com/app` → `gemini.google.com/app/{id}` after first message in a new conversation. ID is a 16-char hex string.
- During generation, a Stop button appears (`button[aria-label*='Stop']`). This is the reliable "busy" signal.
- After generation, the Stop button disappears. `message-content` count increments by 1.
- Image generation: `generated-image` appears while loading, `img.naturalWidth = 0` until fully decoded. Download button appears on hover.
- Conversation history survives page reload if navigated to conversation URL.
- Multiple tabs in the same context can hold different conversations. The SPA does NOT sync between tabs (verified by diagnostic script).

---

## Running Locally

```bash
# Install
npm install
npx playwright install chrome  # or use system Chrome via PLAYWRIGHT_EXECUTABLE_PATH

# Configure
cp .env.example .env
# Set TELEGRAM_BOT_TOKEN, ALLOWED_USERS, ALLOWED_GROUPS

# First run (headed, to log in to Google)
PLAYWRIGHT_HEADLESS=false npm start

# Production (headless)
PLAYWRIGHT_HEADLESS=true npm start
```

Browser profile stored at: `.playwright/profiles/chrome-stable/_shared/`  
Session map stored at: `.playwright/profiles/chrome-stable/sessions.json`

---

## Environment Variables

```
TELEGRAM_BOT_TOKEN=...
PLAYWRIGHT_HEADLESS=false          # true for server
PLAYWRIGHT_EXECUTABLE_PATH=...     # optional, auto-detects system Chrome
GEMINI_PROFILE_DIR=_shared         # subfolder for browser profile
ALLOWED_USERS=123,456              # comma-separated Telegram user IDs
ALLOWED_GROUPS=-100123,-100456     # comma-separated chat IDs
STREAM_POLL_INTERVAL_MS=700
STREAM_STABLE_TICKS=4
STREAM_FIRST_CHUNK_TIMEOUT_MS=25000
STREAM_MAX_DURATION_MS=90000
```
