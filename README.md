<p align="center"><img src="logo.svg" alt="promptq" width="600"/></p>

> Queue prompts when Claude hits its rate limit or while it's responding. They fire automatically the moment Claude is ready — keep your flow.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)
![Open Source](https://img.shields.io/badge/Open-Source-black)

---

## What it does

promptq injects a queue panel into claude.ai. Type your next prompts while Claude is still responding — or while you're rate limited. They fire automatically in sequence the moment Claude is ready. No more losing your train of thought or checking back manually.

**Two triggers, one queue:**
- **Claude responding** — queued prompts fire the instant the send arrow comes back
- **Rate limit hit** — queued prompts hold until the limit resets, then fire automatically

**Features**
- Strip docks above the composer bar — always visible, click to expand
- Type prompts in the queue panel, hit `+ Add`
- Reorder queue items with ↑ ↓ buttons
- Countdown timer shows exactly when session and weekly limits reset
- Auto-fire on reset (toggleable)
- Wait for response mode — sends each prompt only after Claude replies
- Desktop notification when queue finishes
- Light and dark mode
- Zero data collection — everything stays local on your device

---

## Install

### Load unpacked (developer mode)

1. Clone the repo:
   ```bash
   git clone https://github.com/owlguardco/promptq.git
   ```

2. Open Chrome or Brave → `chrome://extensions`

3. Enable **Developer mode** (toggle, top right)

4. Click **Load unpacked** → select the `promptq` folder

5. Go to [claude.ai](https://claude.ai) — the promptq strip appears above the composer bar

---

## How to use

1. Type a prompt in the **queue panel textarea** and hit **+ Add**
2. Add as many prompts as you want — they stack in order
3. Hit **Fire queue now** to start, or leave **Auto-fire** on and it runs automatically
4. If Claude is mid-response, it waits for the arrow to come back before sending the next
5. If you hit the rate limit, the queue holds and fires the moment the limit resets

---

## How it works

**Interceptor** (`content/interceptor.js`) — runs in the page context and hooks `fetch` before claude.ai's own code uses it. Reads limit data straight from Claude's own traffic: the `/usage` endpoint (exact session and weekly reset timestamps) and the live SSE `message_limit` events that stream during responses. This is the same technique [Claude Counter](https://github.com/she-llac/claude-counter) uses, and it's far more accurate than parsing the rounded percentages shown in the UI.

**Content script** (`content/content.js`) — the core. Receives limit data from the interceptor and watches the send button state (orange arrow = ready, stop square = streaming). Runs a 4-state machine: `IDLE → STREAMING → LIMITED → FIRING`. Injects the queue UI above the composer bar.

**Background service worker** (`background/service-worker.js`) — sets a `chrome.alarms` timer for the rate limit reset time. Fires even when the tab is backgrounded. Sends a `LIMIT_RESET` message to the content script when the alarm triggers.

**Popup** (`popup/popup.html`) — quick status and settings from the extension icon.

---

## A note on reliability

promptq reads Claude's usage endpoints to know when limits reset. These endpoints power Claude's own UI but aren't officially documented as public, so a claude.ai redesign can temporarily break limit detection until the extension is updated. This is a risk shared by every Claude usage-tracker extension. When it happens, the queue still works — you can always fire it manually with **Fire queue now**. Updates are pushed here; run `git pull` and reload the extension to get fixes.

All data stays local. The extension reads only claude.ai's own traffic and your `lastActiveOrg` cookie (to query the usage endpoint). It makes no external requests and collects nothing.

---

## Contributing

PRs welcome. Keep it focused — one tool, one job.

---

## License

MIT

