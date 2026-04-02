# Setup Guide

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js >= 20 | `node --version` |
| Chrome or Chromium | system Chrome is auto-detected when possible |
| Google account | must already be able to use Gemini in the browser |
| Telegram bot token | create it via `@BotFather` |

## 1. Clone and install

```bash
git clone git@github.com:0xfunboy/TeGem.git
cd TeGem
npm install
```

Optional Playwright browser install:

```bash
npm run playwright:install
```

## 2. Configure `.env`

```bash
cp .env.example .env
```

Minimum:

```env
TELEGRAM_BOT_TOKEN=123456789:AAF...
```

Optional allowlist:

```env
ALLOWED_USERS=123456789
ALLOWED_GROUPS=-1001234567890
```

Useful production toggles:

```env
PLAYWRIGHT_HEADLESS=true
PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
```

## 3. First run and Gemini login

```bash
npm run dev
```

Expected startup flow:

1. the bot launches the persistent browser context
2. Gemini opens
3. you log into Google if needed
4. `ensureReady()` confirms the chat input is usable
5. the warmup page closes and real per-session pages are created on demand

You should then see log lines similar to:

```text
[TeGem] Avvio bot Telegram...
[TeGem] Avvio sessione browser...
[TeGem] Sessione Gemini attiva.
[TeGem] Bot pronto. In ascolto...
```

## 4. Basic smoke tests

Test in DM:

```text
/start
/status
ciao
```

Test media flows:

```text
/q spiega questa immagine   (with attached image)
/vision                      (reply to an image)
/imagine un tramonto synthwave
/music dark ambient industrial track
/video a robot walking in rain
```

Test group behavior:

- send a normal message without mention: bot should ignore it
- reply to someone with `@BotUsername contesta questo`
- reply to someone else's image with `/q fai OCR`
- reply to someone else's image with `/vision`

## 5. Production build

```bash
npm run build
npm start
```

## Headless server deployment

### Option A: Xvfb

```bash
sudo apt-get install -y xvfb fonts-liberation libgbm1
Xvfb :99 -screen 0 1440x960x24 &
export DISPLAY=:99
PLAYWRIGHT_HEADLESS=false npm start
```

### Option B: pre-seeded profile

1. log into Gemini once on a machine with UI
2. copy `.playwright/` to the server
3. run with `PLAYWRIGHT_HEADLESS=true`

## Keeping the bot alive

### systemd

```ini
[Unit]
Description=TeGem Telegram Bot
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/TeGem
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=10
Environment=DISPLAY=:99

[Install]
WantedBy=multi-user.target
```

### PM2

```bash
npm install -g pm2
pm2 start dist/index.js --name tegem
pm2 save
pm2 startup
```

## Operational notes

- the Chrome profile is shared, but Gemini pages are separated per session key
- `sessions.json` stores sessionKey → conversationUrl mappings
- if you change bot behavior around session identity, old mappings in `sessions.json` may need manual cleanup
