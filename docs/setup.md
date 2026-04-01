# Setup Guide

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | ≥ 20 | `node --version` to check |
| Google Chrome | any recent | or Chromium via `npm run playwright:install` |
| Google Account | — | must be able to log into gemini.google.com |
| Telegram Bot Token | — | create one via [@BotFather](https://t.me/BotFather) |

---

## Step 1 — Create a Telegram Bot

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` and follow the prompts
3. Copy the **token** (format: `123456789:AAF...`)

---

## Step 2 — Clone and Install

```bash
git clone git@github.com:0xfunboy/TeGem.git
cd TeGem
npm install
```

If you want to use the Playwright-managed Chromium instead of system Chrome:

```bash
npm run playwright:install
# then set in .env:
# PLAYWRIGHT_BROWSER_CHANNEL=chromium
```

---

## Step 3 — Configure `.env`

```bash
cp .env.example .env
```

Minimum required:

```env
TELEGRAM_BOT_TOKEN=123456789:AAF...
```

All other settings have sensible defaults. See [configuration reference](../README.md#configuration-reference) for full options.

---

## Step 4 — First Run & Gemini Login

```bash
npm run dev
```

On first run:

1. Chrome opens and navigates to `gemini.google.com`
2. **Log in with your Google account** in the browser window that appears
3. Once logged in and the Gemini chat interface is visible, the bot is ready
4. The session is saved to `.playwright/profiles/` — no re-login needed on restart

You should see in the terminal:

```
[TeGem] Nessun profilo Gemini salvato. Al primo messaggio si aprirà il browser per il login.
[TeGem] Bot pronto. In ascolto...
[TeGem] @YourBotName in ascolto
```

---

## Step 5 — Test the Bot

Send `/start` to your bot in Telegram. Then try:

```
/help
/status
Hello, who are you?
/imagine a neon cyberpunk city at night
```

---

## Production Build

```bash
npm run build   # compiles TypeScript to dist/
npm start       # runs dist/index.js
```

---

## Headless Server (VPS / Docker)

### Option A — Xvfb virtual display

```bash
sudo apt-get install -y xvfb fonts-liberation libgbm1
Xvfb :99 -screen 0 1440x960x24 &
export DISPLAY=:99
PLAYWRIGHT_HEADLESS=false npm start
```

### Option B — Copy a saved profile

1. On your local machine, run TeGem once and log in to Gemini
2. Copy `.playwright/` to the server:
   ```bash
   scp -r .playwright/ user@server:/path/to/TeGem/
   ```
3. On the server, set `PLAYWRIGHT_HEADLESS=true` and start the bot

### Option C — True headless (experimental)

```env
PLAYWRIGHT_HEADLESS=true
```

Works only if you already have a saved profile with a valid Gemini session. Headless Chrome may be detected by Google and trigger re-authentication.

---

## Keeping the Bot Running

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
