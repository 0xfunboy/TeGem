# Architecture

## Overview

TeGem is organized around four runtime concerns:

```text
┌──────────────────────────────┐
│ Telegram Layer               │  grammY routing, commands, auth, reply threading
├──────────────────────────────┤
│ Session Routing Layer        │  sessionKey → Playwright Page, mutex, persistence
├──────────────────────────────┤
│ Gemini Provider Layer        │  DOM automation, uploads, downloads, streaming
├──────────────────────────────┤
│ Browser / Storage Layer      │  persistent Chrome profile + sessions.json
└──────────────────────────────┘
```

## Telegram Layer (`src/bot/`)

Main responsibilities:

- command registration
- group mention parsing
- reply-thread targeting
- media-aware `/q` and `/vision`
- allowlist enforcement
- progressive Telegram message edits during generation

Key files:

- `src/bot/bot.ts`
- `src/bot/sessionKey.ts`
- `src/bot/middleware/auth.ts`
- `src/bot/middleware/typing.ts`
- `src/bot/commands/*.ts`

### Message routing

- private chat plain text goes straight to Gemini
- group plain text is ignored unless the bot is mentioned
- `/q` is command-driven and can use:
  - attached media on the command message
  - media from the replied-to message
- `/vision` is a dedicated media-analysis command for replied or attached media
- mention replies in groups answer under the original replied-to message, not under the tagging message

## Session Routing Layer (`src/gemini/session.ts`)

`GeminiSessionManager` keeps one Playwright `Page` per session key and one shared `BrowserContext`.

### Session keys

- private chat: `user_<telegramUserId>`
- group chat: `group_<chatId>_user_<userId>`

This means:

- each user has their own Gemini conversation in DM
- each user has their own Gemini conversation inside each group
- two users in the same group do not share a Gemini thread

### Concurrency model

- one mutex per session key via `withLock()`
- prompts for the same session are serialized
- different session keys can run in parallel

### Persistence model

Conversation URLs are stored in `sessions.json` via `ConversationStore`.

When Gemini turns `https://gemini.google.com/app` into `https://gemini.google.com/app/<conversationId>`, the new conversation URL is saved and later restored on restart.

The session manager also guards against duplicate conversation ownership: if the same Gemini conversation ID is seen under two different session keys, the duplicate mapping is ignored and the new session is forced to start from a fresh conversation.

## Gemini Provider Layer (`src/gemini/provider.ts`)

`GeminiProvider` is the DOM automation engine.

Primary capabilities:

- `ensureReady()` waits for the Gemini input to be usable
- `sendPrompt()` types and submits prompts
- `streamResponse()` polls the DOM and yields text deltas
- `uploadFile()` attaches local files to the current Gemini prompt
- `captureImages()` downloads Gemini-generated images
- `downloadGeneratedMusic()` downloads both the music video and MP3 variants
- `downloadGeneratedMedia()` handles generated video/audio cases exposed directly in the DOM
- `downloadLastResponseAudio()` attempts Gemini TTS capture for `/voice`

### Streaming flow

```text
snapshotConversation()
sendPrompt()
loop:
  readLastMessage()
  detect busy / stable state
  yield text deltas
finalizeMessage()
capture generated media if present
```

### Upload flow

`uploadFile()` now supports multiple Gemini UI variants:

- direct `input[type="file"]`
- plus / attach button first, then file input
- menu path through "Upload files"
- `filechooser`-driven upload flows

After attaching, it waits for a visible attachment preview before submitting the prompt.

## Browser / Storage Layer

The browser layer is one persistent Chrome profile:

- profile root: `.playwright/profiles/<namespace>/_shared/`
- session mapping file: `.playwright/profiles/<namespace>/sessions.json`

This design keeps Google login state persistent while allowing many Gemini tabs, one for each Telegram session key.

## Current Design Notes

- `SYSTEM_PROMPT` still exists in config, but the current runtime flow does not inject it into Gemini automatically
- `/music` and `/video` intentionally send generated text separately from Telegram media messages to avoid caption-length failures
- `/voice` remains best-effort and should still be treated as experimental
