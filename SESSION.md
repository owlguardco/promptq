# promptq — Session Handoff (v2 rebuild)

All three v2 tasks from `CLAUDE.md` are implemented and committed to `main`.
Two things still need **live verification on a logged-in claude.ai tab** — this
doc tells the next session exactly how.

## Baseline commits

| Task | Commit | Summary |
|------|--------|---------|
| 1 — API-only usage/limit detection | `a7ea394` | interceptor.js parses real `/usage` + SSE `message_limit` shapes; removed DOM scraping |
| 2 — Clear completed queue items   | `c6e3048` | "Clear done" button + auto-clear toggle; IndexedDB blob store |
| 3 — Queue attachments/images       | `fbecc55` | blobs in IndexedDB, replay into composer on fire |

If you need to confirm you're on the right baseline: `git log --oneline -3`
should show `fbecc55` at HEAD.

---

## Caveat 1 — Task 1 usage/limit shapes are reference-verified, not live-verified

The parsing in `content/interceptor.js` matches the shapes used by the
`she-llac/claude-counter` userscript (see `reference/`), **not** a payload
captured from a live session. High confidence, but confirm before trusting the
limit countdown.

### How to verify

1. Load unpacked at `chrome://extensions` (Developer mode → Load unpacked → repo root).
2. Open `https://claude.ai`, open DevTools console.
3. The interceptor runs in the **MAIN world**, the content script in the
   **isolated world**. Console logs from `content.js` are prefixed `[promptq]`.
   On load you should see:
   - `[promptq] interceptor ready in page context`
   - `[promptq] USAGE { session: {...}, weekly: {...} }` (from the proactive
     `/usage` fetch on load)
4. Send a message to Claude. As the response streams you should see:
   - `[promptq] MESSAGE_LIMIT { session: {...}, weekly: {...} }`

### What to check in each payload

After normalization (what `content.js` receives) every payload should look like:

```js
{ session: { resetsAt: <epoch ms>, utilization: <0-100> },
  weekly:  { resetsAt: <epoch ms>, utilization: <0-100> } }
```

- `resetsAt` must be a **future epoch-ms** number (e.g. ~1.7e12). If you see a
  value ~1.7e9 it's seconds that didn't get multiplied — see fix below.
- `utilization` must be **0–100**. If you see 0–1 the fraction→percent scaling is
  wrong for that source.

To see the **raw** (pre-normalization) shapes, temporarily log inside the
interceptor. In `content/interceptor.js`:
- `/usage` raw: add `console.log('RAW usage', data)` at the top of
  `parseUsageResponse()` (line ~47).
- SSE raw: add `console.log('RAW message_limit', ml)` at the top of
  `parseMessageLimit()` (line ~67).

Reload the extension after editing, then repeat steps 3–4. Confirm the raw
object actually has these keys:
- `/usage`: `data.five_hour` / `data.seven_day`, each with `.utilization`
  (0–100) and `.resets_at` (ISO string).
- SSE: `ml.windows['5h']` / `ml.windows['7d']`, each with `.utilization` (0–1
  fraction) and `.resets_at` (unix **seconds**).

### If the /usage shape differs — where to fix

All in `content/interceptor.js`:

| If the difference is… | Fix at |
|---|---|
| Window keys renamed (not `five_hour`/`seven_day`) | `parseUsageResponse()` lines **58–59** — change `data.five_hour` / `data.seven_day` |
| Utilization not 0–100 (e.g. a 0–1 fraction) | `parseUsageResponse()` line **52** — multiply by 100 (currently passed through as-is) |
| `resets_at` field renamed | `parseUsageResponse()` line **53** — change `w.resets_at` |
| SSE window keys renamed (not `5h`/`7d`) | `parseMessageLimit()` lines **78–79** — change `ml.windows['5h']` / `['7d']` |
| SSE utilization NOT a 0–1 fraction | `parseMessageLimit()` line **72** — remove the `* 100` |
| SSE `resets_at` is already ms / ISO, not unix seconds | `parseMessageLimit()` line **73** — `toMs()` auto-detects sec vs ms via the `>1e12` threshold (line ~40); ISO strings also handled. Usually no change needed. |
| SSE event not wrapped as `{type:'message_limit', message_limit:{...}}` | `scanSSELine()` line **93** — adjust the `json.type` / `json.message_limit` access |

`toMs()` (line ~40) handles unix-seconds vs epoch-ms vs ISO automatically, so
timestamp-format differences usually need no change — only field-name and
utilization-unit differences do.

After any fix: reload extension, re-run steps 3–4, confirm normalized payload is
correct, then **remove the temporary `console.log` lines** and commit.

### Downstream (only touch if shapes were correct but behavior is wrong)
`content/content.js`:
- `applyUsage()` (~line 188) maps the normalized payload into
  `state.sessionReset/weeklyReset/sessionUtil/weeklyUtil`.
- `isHardLimited()` (~line 160) returns true when `utilization >= 100` and reset
  is in the future. If Claude's "exhausted" state is signalled at a threshold
  below 100, adjust the comparison here.

---

## Caveat 2 — Task 3 file injection is unverified

`attachFilesToComposer()` in `content/content.js` (~line 820) tries **three**
methods in order to get a queued file into Claude's composer so Claude's own
upload pipeline runs. Which one Claude actually accepts is unconfirmed.

The three methods, in the order the code tries them:
1. **Real file input** — find Claude's hidden `<input type="file">`, set
   `.files` via a `DataTransfer`, dispatch `input` + `change`.
2. **Synthetic drop** — dispatch `dragenter`/`dragover`/`drop` carrying a
   `DataTransfer` onto the composer/form.
3. **Paste** — dispatch a `paste` `ClipboardEvent` with the files (images mainly).

### How to verify and tell which method won

1. Queue a prompt **with an attachment** (paperclip or drag a file onto the
   panel textarea), then fire the queue (or let auto-fire run when ready).
2. Watch the composer: the accepted method is the one after which Claude shows
   the file thumbnail/upload chip in its composer. If a thumbnail appears and
   the send button briefly disables then re-enables, upload succeeded.
3. To know **which** method fired, add temporary logs in
   `attachFilesToComposer()` — a `console.log('method 1: file input')` right
   before the `return true` in each of the three blocks (~lines 826/838/848).
   The last one logged before the thumbnail appears is the winner.

### Test order recommendation
**Test method 1 (real file input) first** — it's the most reliable and most
likely correct, because firing the input's `change` is exactly what Claude's own
paperclip button does. If method 1's log prints but no thumbnail appears, Claude
is probably not using a plain `<input type=file>` (could be an OPFS/drag-only
dropzone) — then method 2 (drop) is the likely winner.

### If none work
- Confirm `findComposerFileInput()` (~line 803) is locating Claude's input and
  not returning `null` (log it). The selector excludes our own `#pq-file-input`.
- For the drop path, the event target matters — Claude's dropzone listener may be
  on a different element than `editable.closest('form')`. Try dispatching on the
  contenteditable itself, or on a parent with a `data-testid`/dropzone class.
- Whichever single method proves correct, you can delete the other two for
  clarity once confirmed.

### Graceful degradation (current behavior)
If injection silently fails, `submitPrompt()` waits via `waitForArrow()` and
then sends **text-only** rather than hanging. So a broken injection looks like
"the file didn't attach," not a stuck queue. Good for safety; bad if unnoticed —
verify visually per above.

### Storage notes
- File bytes live in IndexedDB (`promptq` db, `attachments` store) via
  `attachStore` (~line 928). Only metadata `{id,name,type,size}` is persisted to
  `chrome.storage` (see `saveState()`).
- Blobs are freed (`attachStore.del`) on "Clear done", "Clear all", and per-item
  remove via `releaseItemAttachments()`.

---

## Quick reference — key locations

`content/interceptor.js` (MAIN world, document_start):
- `toMs()` ~40 · `parseUsageResponse()` ~47 · `parseMessageLimit()` ~67 ·
  `scanSSELine()` ~88 · proactive fetch ~150

`content/content.js` (isolated world):
- `applyUsage()` ~188 · `isHardLimited()` ~160 · `limitedResetAt()` ~168 ·
  message listener ~ (search `promptq-interceptor`) · `fireQueue()` ~290 ·
  `submitPrompt(item)` ~395 · `clearDone()` ~330 · `attachStore` ~928 ·
  `addPrompt()` ~730 · `attachFilesToComposer()` ~820 ·
  `findComposerFileInput()` ~803 · `loadAttachmentFiles()` ~790

## Dev loop
Load unpacked at `chrome://extensions`, open `claude.ai` with the console open.
Reload the extension after every edit (the reload icon on the extension card).
Commit each task separately, `fix:`/`feat:` prefix, no co-author line.
