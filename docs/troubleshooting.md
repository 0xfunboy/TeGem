# Troubleshooting

## Gemini not ready / login required

Symptom:

- startup warns that Gemini is not ready
- bot replies with a login/not ready error

Likely cause:

- expired Google session
- invalid or missing Chrome profile state

Fix:

1. run in headed mode
2. open Gemini manually in the launched browser
3. complete login / verification
4. retry once the input box is visible

## `/q` on media is ignored

Symptom:

- `/q ...` works as text
- `/q ...` on an attached image or replied image does nothing

Checks:

- confirm the message is actually a Telegram photo or document
- if in a group, ensure the message really starts with `/q`
- restart the bot after deploying command-routing changes

Current supported cases:

- attached image + `/q ...`
- reply to image + `/q ...`
- media caption starting with `/q ...`

## Gemini file upload fails

Symptom:

- error like `Upload file Gemini non disponibile`
- bot opens the `+` menu in Gemini but does not attach the file

Cause:

- Gemini changed the upload menu DOM
- the hidden file input appears only after clicking `Upload files`
- Playwright reached the wrong upload target

Fix:

- inspect the real Gemini upload entry in DevTools
- verify `data-test-id="local-images-files-uploader-button"` still exists
- if UI changed, update `uploadFile()` selectors in `src/gemini/provider.ts`

## Cross-group / cross-user answer bleed

Symptom:

- one group's request answers using another group's Gemini conversation
- text or generated media seems to belong to the wrong Telegram thread

Cause:

- duplicate or stale session mappings in `.playwright/profiles/<namespace>/sessions.json`

Fix:

1. inspect `sessions.json`
2. remove the bad session entry
3. restart the bot
4. let the session recreate a fresh Gemini conversation

The runtime now tries to detect duplicate conversation ownership automatically, but already-corrupted local session mappings may still need cleanup.

## Timeout errors

Symptom:

- `Timeout Gemini: ...`

Possible causes:

- Gemini took too long to start generating
- media generation was slower than the configured timeout
- file upload never completed, so no useful generation started

Fix:

```env
STREAM_FIRST_CHUNK_TIMEOUT_MS=45000
STREAM_MAX_DURATION_MS=120000
```

Also verify whether the failing request involved image/video/music generation, because those flows are slower by design.

## Telegram caption too long

Old symptom:

- media send failed with `message caption is too long`

Current behavior:

- `/music` and `/video` send text separately from the media file

If you still hit this, the problem is likely coming from another media path that still uses captions.

## Image generation returns no image

Symptom:

- `/imagine` returns text only
- or says Gemini did not generate images

Possible causes:

- Gemini refused the request
- image container selector changed
- hover/download flow failed

Fix:

- inspect the generated image container in Gemini
- verify `generated-image`, `single-image`, and download button selectors still exist
- retry with a simpler prompt

## `/voice` does not work

Status:

- still experimental

Likely failure points:

- the more-options menu did not open
- Gemini's TTS button selector changed
- audio network capture did not match the real request

If `/voice` is business-critical, inspect the current response menu and audio request pattern before changing unrelated parts of the bot.

## High memory usage

Cause:

- one tab per active session key remains open

Mitigations:

- restart the service periodically
- clear unused sessions
- add future tab eviction/LRU if the user base grows
