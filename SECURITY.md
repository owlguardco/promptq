# Security

## What promptq does and does not do

**Does:**
- Read the claude.ai DOM to detect rate limit banners and the send button state
- Store your queued prompts locally in `chrome.storage.local` — on your device only
- Inject text into claude.ai's composer and click the send button on your behalf
- Send desktop notifications when the queue finishes

**Does not:**
- Make any network requests outside of claude.ai
- Collect, transmit, or log any of your prompts or conversation data
- Request access to any site other than `https://claude.ai/*`
- Use `eval()` or execute any remotely loaded code
- Access cookies, browsing history, tabs, or any other browser data
- Require an account, API key, or any external service

## Permissions explained

| Permission | Why it's needed |
|---|---|
| `storage` | Save your queued prompts across sessions (local only) |
| `alarms` | Set a timer to fire prompts when rate limit resets (works even when tab is in background) |
| `notifications` | Alert you when the queue finishes running |
| `https://claude.ai/*` | Inject the queue UI and read the DOM — scoped exclusively to claude.ai |

No other permissions are requested. No `<all_urls>`, no `tabs`, no `webRequest`, no `cookies`.

## Data storage

The only data stored is:

```json
{
  "queue": [{ "id": 123, "text": "your prompt text", "status": "pending" }],
  "autoFire": true,
  "waitForResponse": true,
  "delayBetween": 800
}
```

This lives in `chrome.storage.local` — it never leaves your device.

## Code integrity

- No external scripts loaded at runtime
- No CDN dependencies
- All source code is in this repo — what you see is what runs
- `innerHTML` usage in the UI is sanitized via `escapeHtml()` before rendering

## Reporting a vulnerability

Open an issue or email the maintainer directly via GitHub. Please do not publicly disclose security issues before they are patched.
