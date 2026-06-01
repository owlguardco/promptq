# promptq — Claude Code Handoff

This is a Chrome extension (Manifest V3) that queues prompts for claude.ai and fires them automatically when Claude is ready — either after finishing a response or when a rate limit resets.

## Architecture

```
promptq/
├── manifest.json              # MV3, scoped to https://claude.ai/* only
├── content/
│   ├── content.js             # Main logic — injected into every claude.ai page
│   └── content.css            # UI styles — uses claude.ai's own CSS variables
├── background/
│   └── service-worker.js      # Alarm manager for rate limit reset timer
├── popup/
│   ├── popup.html/js/css      # Extension icon popup (queue status + settings)
└── icons/                     # 16/48/128px PNGs
```

## State machine (content.js)

The core of the extension is a 4-state machine in `tick()`:

```
IDLE      ←→ STREAMING   (send button toggles between arrow and stop icon)
IDLE      ←→ LIMITED     (rate limit banner detected, alarm set for reset)
IDLE/STREAMING → FIRING  (queue has pending items + autoFire enabled + arrow is up)
FIRING    →  STREAMING   (prompt submitted, waiting for response)
STREAMING →  FIRING      (arrow returns, send next prompt)
FIRING    →  IDLE        (queue empty)
```

`tick()` is called on every relevant DOM mutation (MutationObserver watching `aria-label`, `disabled`, `data-is-streaming` attributes) and every 5s as a safety poll.

## Key functions

### UI injection (`injectUI`)
- Finds the composer form by locating the contenteditable input and walking up to the ancestor that also contains the send button
- Inserts `#promptq-wrapper` (containing `#promptq-panel` + `#promptq-strip`) **before** the composer in the DOM
- Never uses `position: fixed` — docks natively into claude.ai's layout

### Submit button detection
- `getSendButton()` — finds the orange arrow button by aria-label or proximity to contenteditable
- `getStopButton()` — finds the stop/square button that appears while streaming
- `isArrowReady()` — returns true only when orange arrow is present, enabled, and not in stop mode
- `waitForArrow(maxMs)` — polls every 500ms until arrow is ready, 10min ceiling

### Prompt submission (`submitPrompt`)
- Uses `document.execCommand('insertText')` to set text in the ProseMirror contenteditable
- Falls back to `HTMLTextAreaElement` native setter for older builds
- Always waits for `isArrowReady()` before attempting to submit

### Rate limit parsing (`parseMeterBar`)
- Walks text nodes looking for "resets in X" patterns
- Handles: `2h 7m`, `49m`, `2d 19h`, `2:00 AM`
- Detects hard limit via banner text: "Usage limit reached", "Keep working"

## CSS variables
The CSS uses claude.ai's runtime variables so it inherits the correct theme automatically:
- `--bg-100/200/300` — surface colors
- `--border-100/200` — border weights
- `--text-primary/secondary/tertiary` — text hierarchy
- `--brand-primary` — the orange accent color
- `--font-sans` — Söhne (claude.ai's UI font)
- `--radius-sm/md` — corner radii
- `--shadow-md` — elevation

## Known issues to fix

1. **Composer detection may fail on initial page load** — if the send button isn't in the DOM when the first `tick()` runs, `injectUI()` returns early. The MutationObserver retries on every DOM change so it self-heals, but there can be a ~1s delay before the strip appears.

2. **execCommand is deprecated** — `document.execCommand('insertText')` works in all current browsers but is deprecated. The correct approach is to use the ProseMirror editor's own dispatch mechanism. See: `editor.view.dispatch(editor.view.state.tr.insertText(text))` — but requires finding the ProseMirror instance on the DOM node.

3. **Send button aria-label is not stable** — Anthropic can rename it at any time. The fallback (walking up from contenteditable to find buttons) should catch renames, but needs real-world testing.

4. **No error recovery UI** — if `submitPrompt` fails, the item is marked `failed` but there's no retry button in the UI.

5. **Popup doesn't sync live** — the popup reads state from `chrome.storage` but doesn't update in real time if the queue is firing. Uses `storage.onChanged` listener but this may lag.

## What Claude Code should focus on

- [ ] Real-world testing of `findComposerAnchor()` — does it find the right element on all claude.ai routes (`/chat`, `/project/*`, new conversation)?
- [ ] Test the send button detection — log `getSendButton()` and `isArrowReady()` on a live page
- [ ] Replace `execCommand` with ProseMirror native dispatch
- [ ] Add a retry button to failed queue items
- [ ] Add E2E tests (Playwright against claude.ai in a test account)
- [ ] Investigate whether Brave's ad blocker interferes with MutationObserver or DOM injection

## Dev setup

```bash
git clone https://github.com/owlguardco/promptq
# Load unpacked in chrome://extensions (Developer mode on)
# Open claude.ai, check DevTools console for [promptq] logs
```

No build step. No dependencies. Plain JS/CSS.

## Security constraints (do not break these)

- No external network requests — all data stays local
- No `eval()` or dynamic code execution
- All `innerHTML` must go through `escHtml()` sanitizer
- Permissions must stay scoped to `https://claude.ai/*` only
- Nothing sensitive stored in `chrome.storage` (no tokens, no conversation content)
