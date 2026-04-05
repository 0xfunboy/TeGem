# Bot Commands

The same slash-command set is available on both Telegram and WhatsApp. Telegram keeps the native bot menu; WhatsApp uses normal messages that begin with `/`.

## `/start`

Shows a short introduction and the main commands.

## `/help`

Shows the command list.

## `/clear`

Clears the current Gemini conversation for the current session key.

Meaning:

- in DM: clears that user's DM Gemini thread
- in group: clears only that user's Gemini thread for that group

## `/status`

Shows runtime information for the current session key.

Typical output includes:

- session key
- stored conversation ID
- current Gemini page URL if active
- number of active tabs in the browser context
- headless status

## `/q <question>`

General-purpose query command.

Supported modes:

- `/q question text`
- `/q question text` with attached photo/document
- reply to someone else's photo/document with `/q question text`
- attached photo/document with caption `/q question text`
- reply to someone else's image with `/q` and no extra text

If `/q` has media but no text, the fallback prompt is a generic image-description request.

Reply behavior:

- when replying to someone else's media, the bot replies under the original media message
- the replied media is downloaded from Telegram, uploaded into Gemini, then combined with the prompt

## `/vision [prompt]`

Dedicated image/file analysis command.

Supported modes:

- reply to a photo/document image with `/vision`
- reply to a photo/document image with `/vision fai OCR e riassumi`
- attach an image together with `/vision`

Default prompt:

- `Describe this image in detail.`

Use `/vision` when the primary task is visual analysis rather than a general chat query.

## `/imagine <description>`

Asks Gemini to generate an image and forwards the resulting image to Telegram.

Behavior:

- waits longer than normal text requests
- downloads the generated image via Gemini's UI
- sends the image back as a Telegram photo
- if Gemini returns only text, the text is sent instead

## `/music <description>`

Asks Gemini to generate music.

Behavior:

- submits a `Create music: ...` style prompt
- waits for Gemini's music generation workflow
- opens Gemini's download menu and tries both outputs:
  - video
  - audio-only MP3
- sends the media files first
- sends any long text or lyrics as a separate Telegram text message, not as a caption

## `/video <description>`

Asks Gemini to generate a video.

Behavior:

- uses longer generation timeouts than normal chat
- downloads the generated media
- sends text separately from the Telegram video message

## `/voice`

Best-effort TTS capture for the most recent Gemini response in the current session.

Important:

- works only if that session already has an active page and recent Gemini response
- still depends on Gemini's UI structure and remains less reliable than text/image/music/video flows

## Free-text messages

### Private chats

- plain text is sent directly to Gemini
- attached media with a caption is handled through the media flow
- media captions using `/q` are treated like command invocations

### Groups / supergroups

- plain text is ignored unless the bot is mentioned
- `@TeGemAI_bot ...` in reply to another message includes the replied text as context
- the bot replies under the original replied-to message when applicable
- media with caption `/q ...` works without a mention
- media with caption `@TeGemAI_bot ...` also works
- on WhatsApp groups the logic is the same, but the mention target is the linked WhatsApp account instead of a Telegram username

## Access control

Access is deny-by-default:

- if `ALLOWED_USERS` is empty or unset, all private chat users are rejected
- if `ALLOWED_GROUPS` is empty or unset, all groups are silently ignored
- if `WHATSAPP_ALLOWED_USERS` is empty or unset while WhatsApp is enabled, all private WhatsApp users are rejected
- if `WHATSAPP_ALLOWED_GROUPS` is empty or unset while WhatsApp is enabled, all WhatsApp groups are silently ignored
- unauthorized private users receive a rejection message
- unauthorized groups are silently dropped

## Rate limiting

A per-user cooldown (default 3s) is enforced between requests. Configurable via `RATE_LIMIT_MS` in `.env`. Commands `/start`, `/help`, `/status` are exempt from the cooldown.
