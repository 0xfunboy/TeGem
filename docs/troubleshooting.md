# Troubleshooting

## Gemini not ready / login required

**Symptom:** Bot replies "Gemini non è pronto. Potrebbe essere necessario effettuare il login."

**Cause:** No saved Playwright profile, or the Google session has expired.

**Fix:**
1. Run `npm run dev` — Chrome will open
2. Navigate to `gemini.google.com` and log in manually
3. Once the chat interface is visible, send a message to the bot to trigger session initialization
4. The profile is saved; subsequent restarts will auto-login

---

## Bot responds with "Risposta vuota da Gemini"

**Symptom:** Message edited to "Risposta vuota da Gemini. Riprova."

**Cause:** DOM polling finished but no text was extracted. Usually happens if:
- Gemini changed its HTML structure (selectors no longer match)
- Response was too short to pass the noise filter
- Gemini produced only an image with no caption

**Fix:**
- Check that `gemini.google.com` still uses `message-content` as the response element
- Try `/clear` to start a fresh conversation
- Try increasing `STREAM_STABLE_TICKS` in `.env` to give more time

---

## Timeout errors

**Symptom:** "Timeout Gemini: nessuna risposta entro il timeout iniziale"

**Cause:** Gemini took longer than `STREAM_FIRST_CHUNK_TIMEOUT_MS` (default 25s) to start responding.

**Fix:**
```env
STREAM_FIRST_CHUNK_TIMEOUT_MS=45000
STREAM_MAX_DURATION_MS=120000
```

---

## Quota exhausted

**Symptom:** Bot replies "Quota Gemini esaurita per oggi."

**Cause:** Your Google account has hit the daily Gemini free-tier limit.

**Fix:** Wait until the limit resets (usually midnight Pacific Time), or use a different Google account. Update `GEMINI_PROFILE_DIR` in `.env` to point to a profile for the other account.

---

## Chrome not found

**Symptom:** Error: `browserType.launchPersistentContext: Failed to launch browser`

**Fix A — Use system Chrome:**
```bash
which google-chrome-stable   # should output a path
# TeGem auto-detects /usr/bin/google-chrome-stable
```

**Fix B — Use Playwright Chromium:**
```bash
npm run playwright:install
```
Then in `.env`:
```env
PLAYWRIGHT_BROWSER_CHANNEL=chromium
```

---

## High CPU / memory on server

**Symptom:** Chrome process consuming excessive resources.

**Cause:** Playwright's persistent context keeps Chrome running continuously.

**Fix:**
- Ensure only one instance of TeGem is running
- Restart the bot periodically via systemd `RestartSec` or PM2 cron restart
- On low-memory servers, use `PLAYWRIGHT_HEADLESS=true` with a pre-saved profile

---

## Message too long for Telegram

**Symptom:** `editMessageText` fails silently, or message appears truncated.

**Cause:** Telegram's message limit is 4096 characters.

**Current behavior:** If `editMessageText` fails, the bot falls back to sending a new message with `ctx.reply()`.

**Workaround:** Ask Gemini to be more concise, or break your question into parts.

---

## Image not captured

**Symptom:** `/imagine` returns text instead of a photo, or "Gemini non ha generato immagini."

**Cause:**
- Gemini generated the image in a container that doesn't match the known selectors
- The image is too small (< 120×120 px bounding box)
- Image generation is unavailable for your account/region

**Fix:**
- Check Chrome's DevTools on the Gemini page to identify the actual image container selector
- Update `getImageSelectors()` in `src/gemini/provider.ts` with the new selector
