# promptq — Claude Code Handoff (v2 rebuild)

Chrome MV3 extension that queues prompts for claude.ai and fires them when Claude is ready (after a response finishes, or when a rate limit resets).

**The aesthetic and panel UI are good. Three things need a real rebuild. Do them in order.**

---

## TASK 1 — Replace DOM text-parsing with Claude's real usage API (HIGH PRIORITY)

**Problem:** Current code reads limit reset times by scraping the "Session: X% · resets in Yh" text from the DOM with a TreeWalker. It's unreliable and gets session vs weekly mixed up.

**Solution:** Copy how `she-llac/claude-counter` (v0.4.2) does it. Read the source at https://github.com/she-llac/claude-counter/blob/main/userscript/claude-counter.user.js for reference.

The technique:
1. A page-context script hooks `window.fetch` BEFORE claude.ai's code runs (must be injected via a `<script>` tag or `world: "MAIN"`, not the isolated content-script world)
2. It watches two endpoints:
   - `/api/organizations/{orgId}/usage` — returns full session (5-hour) + weekly (7-day) limits with exact `resets_at` timestamps
   - SSE `message_limit` events that stream during completions — carry live exact `resetsAt` and utilization
3. It posts parsed data back to the content script via `window.postMessage`

**I've already written `content/interceptor.js`** — the page-context hook. Your job:
- [ ] Verify the actual shape of the `/usage` JSON and the SSE `message_limit` event by logging them on a live claude.ai session. The parsing in interceptor.js is a best guess — FIX IT to match reality.
- [ ] Register interceptor.js in manifest.json as a content script with `"world": "MAIN"` and `"run_at": "document_start"` (MV3 supports this), OR inject it via a script tag from the content script. MAIN world is cleaner.
- [ ] In content/content.js, add a `window.addEventListener('message', ...)` listener that receives `{ source: 'promptq-interceptor', type: 'USAGE' | 'MESSAGE_LIMIT', payload }` and updates `state.sessionReset` / `state.weeklyReset` / the hard-limit state from it.
- [ ] Remove the old `parseMeterBar()` and `parseResetTime()` TreeWalker functions entirely — the API is the only source of truth now.
- [ ] The hard-limit detection (`isHardLimited()`) should now key off the SSE `message_limit` type being "exceeded_limit" (or whatever the real value is), not banner text.

**Privacy constraint:** reads only claude.ai's own traffic + the `lastActiveOrg` cookie. No external requests. Keep it that way.

---

## TASK 2 — Clear completed queue items (Sonnet couldn't crack this)

**Problem:** After items fire and show "done", they stick around. There's no way to clear just the completed ones.

**Fix in content/content.js:**
- [ ] Add a "Clear done" button in the panel footer next to "Clear all" that removes only items where `status === 'done'` (keep pending/failed)
- [ ] After a fireQueue() run completes, auto-remove done items after a short delay (e.g. 3s) OR add an "auto-clear completed" toggle in settings (default on)
- [ ] Make sure `renderQueueList()` and `scheduleRender()` actually reflect the cleared state — the bug may be that state.queue is mutated but the debounced render reads a stale copy

---

## TASK 3 — Queue attachments and images, not just text (the big feature)

**Problem:** You can only queue text. The user wants to queue anything they'd put in the composer: images, file attachments, pasted content.

This is hard because claude.ai uploads attachments to its backend and references them by ID. Approach:
- [ ] Investigate how claude.ai handles composer attachments — when you attach a file, does it upload immediately and store a file ID/reference in the composer state? Or hold the File object until send?
- [ ] If files upload immediately: the queue item needs to store the uploaded file reference/ID so it can be re-attached when the prompt fires. Hook the upload endpoint in interceptor.js to capture file IDs.
- [ ] If files are held client-side: the queue item needs to store the actual File/Blob objects (in memory, since chrome.storage can't hold blobs well — or use IndexedDB).
- [ ] The queue item model changes from `{ id, text, status }` to `{ id, text, attachments: [...], status }`
- [ ] When firing: re-populate the composer with both text AND attachments before clicking send
- [ ] Update the panel UI to show a paperclip/thumbnail on queue items that have attachments
- [ ] Add a way to attach files to a queued prompt from the panel (file input or drag-drop onto the textarea)

Start by logging claude.ai's attachment upload flow in the console to understand it before writing code.

---

## Architecture recap

- `content/interceptor.js` — NEW, page-context (MAIN world), hooks fetch for usage/SSE
- `content/content.js` — isolated world: state machine, queue UI, firing logic
- `content/content.css` — styles (good, leave mostly alone)
- `background/service-worker.js` — chrome.alarms for reset timer, notifications
- `popup/` — status + settings

State machine: `IDLE → STREAMING → LIMITED → FIRING`. Send button state (orange arrow vs stop square) drives STREAMING. Now the SSE message_limit drives LIMITED instead of banner text.

## Security constraints (do not break)
- No external network requests — only claude.ai's own traffic
- No eval / no remote code
- All innerHTML through escHtml()
- Permissions stay scoped to https://claude.ai/*
- No tokens or conversation content in chrome.storage

## Dev loop
```bash
# load unpacked at chrome://extensions, open claude.ai with console
# the ci-verify skill exists if you want a sanity check
```
Commit each task separately. No co-author lines in commits. Commit format: "fix:" or "feat:" + description.
