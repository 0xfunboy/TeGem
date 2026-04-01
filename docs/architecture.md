# Architecture

## Overview

TeGem is structured in three layers:

```
┌─────────────────────────────┐
│       Telegram Layer         │  grammY bot, commands, streaming edits
├─────────────────────────────┤
│       Gemini Provider        │  DOM polling, text extraction, image capture
├─────────────────────────────┤
│     Playwright Session       │  persistent Chrome context, profile management
└─────────────────────────────┘
```

## Telegram Layer (`src/bot/`)

Handles all Telegram interaction via [grammY](https://grammy.dev/):

- **`bot.ts`** — registers commands and the main text handler. For each incoming message it:
  1. Sends an immediate placeholder reply (`"Sto elaborando…"`)
  2. Delegates to `GeminiProvider` for the actual response
  3. Progressively edits the placeholder as streaming chunks arrive
  4. Sends any generated images as `InputFile` photo messages

- **`commands/`** — each command is a standalone handler function, keeping `bot.ts` clean

- **`middleware/typing.ts`** — repeatedly calls `sendChatAction("typing")` every 4 seconds while Gemini is working, so Telegram shows the typing indicator

## Gemini Provider (`src/gemini/provider.ts`)

The core of TeGem. Drives `gemini.google.com` through Playwright's Page API.

### Sending a prompt

```
ensureReady()          wait for rich-textarea to be visible
waitUntilIdle()        wait for any previous response to finish
input.click()
page.keyboard.type()   type prompt into contenteditable
submit.click()         click Send button (or press Enter)
ensurePromptSubmitted() verify textarea is cleared (Gemini-specific validation)
```

### Streaming a response

```
snapshotConversation()   baseline: message count, last text, image srcs
loop every 700ms:
  readAssistantText()    evaluate JS in browser → find top-level message-content
  compare with previous  if changed, yield delta to bot layer
  isBusy()              check for Stop button
  stable ticks          exit loop after 4 consecutive unchanged reads
finalizeMessage()        one last read after loop exits
captureImages()          extract generated images as base64 data URIs
```

### DOM selectors (Gemini-specific)

| Purpose | Selector |
|---|---|
| Input field | `rich-textarea div[contenteditable='true']` |
| Submit button | `button[aria-label*='Send']` (+ variants) |
| Busy indicator | `button[aria-label*='Stop']` |
| Response text | `message-content` (top-level only) |
| Generated images | `.generated-images img`, `generated-image img`, `single-image img` |

### Text sanitization

Gemini's DOM includes UI chrome (nav text, watermarks, noise lines) mixed with response text. `sanitize()` removes known patterns like:

- `"Gemini Apps Activity"` and everything after
- `"You said"`, `"Gemini said"` prefixes
- Italian loading text (`"Caricamento di …"`)
- One-word noise lines (`"gemini"`, `"tools"`, `"fast"`, `"said"`)

## Session Manager (`src/gemini/session.ts`)

Wraps Playwright's `chromium.launchPersistentContext()`:

- **Profile persistence**: saves cookies/localStorage to `.playwright/profiles/<namespace>/<profileDir>/`
- **Single context**: one `BrowserContext` = one Chrome window per profile
- **Alive check**: detects closed pages/contexts and clears stale sessions
- **Deduplication**: concurrent launch requests for the same profile share one `Promise`

## Configuration Flow

```
.env file
   │
   ▼
loadConfig()  (src/config.ts)
   │
   ├── AppConfig.telegram.token   → grammY Bot
   ├── AppConfig.gemini           → GeminiSessionManager
   ├── AppConfig.geminiProvider   → GeminiProvider (selectors, URLs)
   ├── AppConfig.profileDir       → which Playwright profile to use
   └── AppConfig.systemPrompt     → injected into Gemini on session start
```

## System Prompt & Command Awareness

On the **first message** of each Gemini session, the user's text is prefixed with the system prompt:

```
<systemPrompt>

---

<userMessage>
```

This gives Gemini its identity as "TeGem" and injects the command list so it can describe itself accurately when users ask. Subsequent messages in the same session are sent as-is, relying on Gemini's conversation memory.

The system prompt is fully configurable via the `SYSTEM_PROMPT` environment variable.
