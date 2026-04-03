# TeGem — Handoff

**Project**: TeGem  
**Repo**: https://github.com/0xfunboy/TeGem  
**Stack**: TypeScript, Node.js, grammY, Playwright, Gemini web UI  
**Current branch baseline**: `main`

## What TeGem is

TeGem is a Telegram bot that uses the Gemini browser UI as its model backend through Playwright automation. It does not use the Gemini API.

The bot currently supports:

- text chat in DM and groups
- mention-based group interaction
- reply-thread-aware answers
- `/q` with attached media or replied media
- `/vision` for image/file description
- `/imagine`
- `/music`
- `/video`
- `/voice` as an experimental flow

## Runtime model

### Browser model

- one shared persistent Chrome profile
- one shared `BrowserContext`
- one Playwright `Page` per Telegram session key

### Session model

- DM session key: `user_<telegramUserId>`
- Group session key: `group_<chatId>_user_<userId>`

Each session key maps to its own Gemini conversation URL in:

```text
.playwright/profiles/<namespace>/sessions.json
```

### Concurrency

- per-session mutex via `withLock()`
- same session key is serialized
- different session keys run in parallel

## Important files

| File | Role |
|---|---|
| `src/bot/bot.ts` | main Telegram routing, `/q`, `/vision`, media reply logic |
| `src/bot/sessionKey.ts` | session key strategy |
| `src/bot/middleware/auth.ts` | deny-by-default allowlist |
| `src/bot/middleware/rateLimit.ts` | per-user request cooldown |
| `src/gemini/session.ts` | tab-per-session management, restore, duplicate conversation guards |
| `src/gemini/provider.ts` | Gemini DOM automation, upload/download logic |
| `src/gemini/conversationStore.ts` | persistent session mapping store |
| `src/index.ts` | startup, browser warmup, command registration |

## What is stable

- per-user/per-group session isolation
- session restore from `sessions.json`
- reply threading under the original replied-to message
- `/q` with:
  - attached image
  - image in reply
  - caption-based `/q`
- `/vision` on replied or attached media
- `/imagine`
- `/music` sends video/audio files and text separately
- `/video` sends media and text separately

## What is still fragile

### 1. Gemini upload UI

Image/file upload depends on Gemini's current menu structure. The provider now explicitly targets the real `Upload files` menu item, including:

- `data-test-id="local-images-files-uploader-button"`
- related upload menu selectors
- `filechooser` fallback

If vision breaks again, inspect `uploadFile()` first.

### 2. `/voice`

Still best-effort. It depends on:

- the response menu opening
- the TTS button selector staying stable
- the audio network response being capturable

## Security hardening (applied)

The following security measures are now in place:

### Auth: deny-by-default

If `ALLOWED_USERS` or `ALLOWED_GROUPS` are empty or unset, the bot denies all access. This prevents accidental open access if `.env` is corrupted or reset.

### Rate limiting

Per-user cooldown (default 3s) between requests. Configurable via `RATE_LIMIT_MS`. Commands `/start`, `/help`, `/status` are exempt.

### Idle tab eviction

Session tabs are automatically closed after `SESSION_IDLE_TIMEOUT_MS` (default 30 min). The conversation mapping in `sessions.json` is preserved — the tab is seamlessly restored on the next request. A hard cap of `MAX_SESSION_TABS` (default 20) evicts LRU tabs when exceeded.

### Temp file cleanup

Downloaded Telegram media files are cleaned up immediately after use. No more disk accumulation from `tegem-*` temp directories.

### Safe audio capture

`downloadLastResponseAudio()` uses `page.on("response")` listener instead of `page.route("**/*")`. No more proxying all network traffic through a handler that could break the page.

### Parallel-safe keyboard input

`ensurePromptSubmitted()` and `submitPrompt()` use locator-scoped press and explicit element targeting, not `page.keyboard.press()` or `document.activeElement`, which could interfere across parallel tabs.

### Async ConversationStore I/O

`sessions.json` saves are now async and queued. No more blocking the event loop under load.

### Message length splitting

Responses longer than 4096 characters are automatically split across multiple Telegram messages.

## Known operational pitfalls

### Duplicate session mappings

If a session key points to the wrong Gemini conversation, inspect:

```text
.playwright/profiles/chrome-stable/sessions.json
```

Remove the bad entry and restart the bot. The runtime now tries to reject duplicate conversation ownership, but old corrupted mappings can still exist locally.

### Docs vs runtime

`SYSTEM_PROMPT` still exists in config, but it is not part of the current runtime request path. Do not assume command-awareness is injected into Gemini automatically.

## Recommended next areas

1. make `/voice` reliable
2. improve structured visual prompts for OCR/document workflows
3. add stronger logging around upload target selection and media attach success
