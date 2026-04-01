# Bot Commands

## `/start`

Sends a welcome message introducing TeGem and listing the available commands.

**Usage:** `/start`

---

## `/help`

Displays the full list of commands with descriptions.

**Usage:** `/help`

---

## `/clear`

Resets the current Gemini conversation by navigating to a fresh `gemini.google.com/app` page. The Playwright session remains open — only the conversation context is cleared.

**Usage:** `/clear`

**When to use:**
- The conversation has gone off-topic and you want a clean slate
- Gemini is in a confused state or not responding as expected
- You want to reset the system prompt injection

---

## `/status`

Shows the current state of the bot and the Gemini Playwright session.

**Usage:** `/status`

**Output includes:**
- Bot online status
- Gemini session URL (or "Not connected")
- Headless mode flag

---

## `/imagine`

Asks Gemini to generate an image based on a text description. The generated image is captured from the DOM and sent as a Telegram photo.

**Usage:** `/imagine <description>`

**Examples:**
```
/imagine a futuristic city at sunset with neon lights
/imagine a photorealistic cat wearing a space suit
/imagine an oil painting of mountains at dawn
```

**Notes:**
- Image generation depends on Gemini's availability for your account
- If Gemini returns text instead of an image, the text is sent as a message
- Up to 4 images per response are captured and forwarded

---

## Free-text messages

Any message that is not a command is forwarded to Gemini as a conversation turn. The bot:

1. Replies immediately with `"Sto elaborando…"` as a placeholder
2. Sends the message to Gemini and waits for a response
3. Progressively updates the placeholder message as Gemini types (streaming edit with `▌` cursor)
4. Finalizes the message with the complete response

**First message behavior:** the system prompt is prepended to the first message of each session, giving Gemini its TeGem identity and command list.

---

## Command Awareness

TeGem injects a system prompt into Gemini at the start of each conversation. This means Gemini knows:

- Its name is **TeGem**
- What commands are available and what they do
- To explain its capabilities if asked

Example:
```
User: What can you do?
TeGem: I'm TeGem, an AI assistant on Telegram powered by Google Gemini.
       You can ask me anything, and I also support these commands:
       /start, /help, /clear, /status, /imagine <description>
       ...
```

The system prompt is fully customizable via the `SYSTEM_PROMPT` environment variable in `.env`.
