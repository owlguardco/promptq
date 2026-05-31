# promptq

> Keep your flow. Queue prompts when Claude hits its rate limit — they fire automatically when the limit resets.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)
![Open Source](https://img.shields.io/badge/Open-Source-black)

---

## What it does

When Claude hits your usage limit, promptq injects a small queue panel into claude.ai. Type your follow-up prompts there — they'll fire in sequence the moment your limit resets. No more losing your train of thought or checking back manually.

**Features**
- Detects rate limit banners automatically via DOM observer
- Countdown timer shows exactly when the limit resets
- Queue up to as many prompts as you want, reorder them by priority
- Auto-fires when limit resets (or manually trigger anytime)
- "Wait for response" mode — sends each prompt only after Claude replies
- Desktop notifications when the queue finishes
- Draggable panel, dark mode support
- Zero data collection, everything stays local

---

## Install

### Load unpacked (developer mode)

1. Clone this repo:
   ```bash
   git clone https://github.com/owlguardco/promptq.git
   ```

2. Open Chrome and navigate to `chrome://extensions`

3. Enable **Developer mode** (toggle in the top right)

4. Click **Load unpacked** and select the `promptq` folder

5. Visit [claude.ai](https://claude.ai) — promptq will activate automatically when a rate limit is detected

---

## How it works

**Content script** (`content/content.js`) runs on claude.ai. It watches the DOM with a `MutationObserver` for rate limit banners, parses the reset time, and injects the queue panel UI. When the limit lifts, it uses React's native input setter to programmatically type each prompt and submit it.

**Background service worker** (`background/service-worker.js`) manages a `chrome.alarms` timer for the reset — this works even if the tab is backgrounded or the browser is idle. It also handles desktop notifications when the queue completes.

**Popup** (`popup/popup.html`) gives a quick status view and settings from the extension icon.

---

## Usage

1. Hit Claude's rate limit on claude.ai
2. The promptq panel appears in the bottom-right corner
3. Type your next prompts and click **Add** (or Cmd+Enter)
4. Drag items to reorder — the queue fires top-to-bottom
5. promptq will auto-fire when the limit resets

**Manual fire:** If the limit has cleared but you want to use the queue, click **Fire Queue Now**.

**Settings:**
- **Auto-fire on reset** — fires queue automatically when limit clears
- **Wait for response** — waits for Claude to fully respond before sending the next prompt (recommended)

---

## Contributing

PRs welcome. Keep it simple — this should stay a single-purpose tool that does one thing well.

---

## License

MIT
