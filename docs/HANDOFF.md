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
| `src/bot/middleware/auth.ts` | optional allowlist |
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

### 3. Long-lived resource usage

Every active session keeps a tab open. There is still no eviction policy.

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
2. add tab eviction / idle page cleanup
3. improve structured visual prompts for OCR/document workflows
4. add stronger logging around upload target selection and media attach success
