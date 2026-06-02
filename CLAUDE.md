# promptq — Claude Code Handoff

Chrome extension (Manifest V3) that queues prompts for claude.ai and fires them automatically when Claude is ready — after a response finishes or when a rate limit resets.

## Current state

Working: queue UI, add/reorder/remove prompts, auto-fire on ready, fire-on-reset, light/dark theme, auto-clear done items, Cmd+Shift+Q shortcut.

**BROKEN: the rate-limit timers.** We've been scraping the meter bar DOM text ("Weekly resets in 1d 14h") which is rounded, stale, and changes format whenever Anthropic updates the UI. This approach keeps breaking. **It must be replaced.**

## THE FIX — read the real API, not the DOM

The reference implementation `she-llac/claude-counter` (saved in `reference/`) solves this correctly. Study these files:
- `reference/claude-counter-bridge.js` — the fetch-interception bridge (THE key technique)
- `reference/claude-counter-main.js` — how to parse usage data into reset timestamps
- `reference/claude-counter-bridge-client.js` — content-script side of the bridge

### How claude-counter gets accurate timers

It does NOT scrape DOM text. Instead:

1. **Injects a script into the page context** (not the content-script sandbox) that wraps `window.fetch`. This is required because content scripts can't see the page's fetch calls.

2. **Intercepts two things:**
   - **SSE stream** from `/completion` requests — watches for `data:` lines where `json.type === 'message_limit'`. This carries `windows['5h']` and `windows['7d']` with exact `utilization` (0-1 float) and `resets_at` (unix seconds).
   - **The `/api/organizations/{orgId}/usage` endpoint** — returns `{ five_hour: {utilization, resets_at}, seven_day: {utilization, resets_at} }` where `resets_at` is an ISO string. This is the authoritative source.

3. **Gets orgId** from the `lastActiveOrg` cookie, or from intercepted API URLs.

4. **Passes data from page context → content script** via `window.postMessage` with a marker (`{ cc: 'ClaudeCounter', type, payload }`).

### Architecture you need to build

```
manifest.json
  - add "web_accessible_resources" for the injected bridge script
  - content script stays on claude.ai

content/bridge.js   (NEW — injected into PAGE context via <script> tag)
  - wraps window.fetch exactly like reference/claude-counter-bridge.js
  - intercepts SSE message_limit events
  - exposes a "usage" request that calls /api/organizations/{orgId}/usage
  - postMessages results back with a "promptq" marker

content/content.js  (MODIFY)
  - inject bridge.js into the page on load (document_start ideally)
  - listen for postMessage usage data
  - replace parseMeterBar() entirely — delete the DOM scraping
  - use the real resets_at timestamps for the countdown + the SET_ALARM call
```

### Exact data shapes (from reference)

`/usage` endpoint response:
```json
{
  "five_hour":  { "utilization": 43, "resets_at": "2026-06-01T22:00:00Z" },
  "seven_day":  { "utilization": 5,  "resets_at": "2026-06-03T14:00:00Z" }
}
```

SSE `message_limit` event:
```json
{
  "type": "message_limit",
  "message_limit": {
    "windows": {
      "5h": { "utilization": 0.43, "resets_at": 1764626400 },
      "7d": { "utilization": 0.05, "resets_at": 1764777600 }
    }
  }
}
```

Note claude.ai recently dropped the 5-hour session window from the UI — only `seven_day` (Weekly) shows now. Handle the case where `five_hour` is null. Show whatever windows exist.

## Tasks in priority order

1. **Replace DOM scraping with API interception** (above). This fixes the wrong timers permanently. Use the reference bridge.js as the template — adapt the marker from 'ClaudeCounter' to 'promptq', strip the tokenizer/conversation stuff we don't need, keep only the usage + message_limit interception.

2. **Verify the rate-limit HOLD works** — when seven_day utilization hits 100% (or the banner appears), fireQueue must hold pending items and set a chrome.alarm for the real resets_at timestamp.

3. **Test the firing path** — submitPrompt uses execCommand which is deprecated. Reference uses proper input events. Improve if you can find claude.ai's ProseMirror dispatch.

## Hard constraints (security — do not break)

- No external network requests — only claude.ai
- The injected bridge only reads usage data; never sends conversation content anywhere
- No eval
- Permissions stay scoped to https://claude.ai/*
- Nothing sensitive in chrome.storage (no tokens, no message content)
- No co-author lines in commits

## Dev setup

```bash
git clone https://github.com/owlguardco/promptq
# chrome://extensions → Developer mode → Load unpacked → select promptq/
# claude.ai → DevTools console → look for [promptq] logs
```

No build step, plain JS/CSS.
