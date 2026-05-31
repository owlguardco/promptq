(() => {
  'use strict';

  // ─── State ───────────────────────────────────────────────────────────────────
  const STATE_KEY = 'promptq_state';
  let state = {
    queue: [],
    resetAt: null,       // epoch ms when limit resets
    limited: false,
    autoFire: true,
    waitForResponse: true,
    delayBetween: 3000,  // ms between prompts
  };

  let panelInjected = false;
  let firingInProgress = false;
  let observer = null;

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function saveState() {
    chrome.storage.local.set({ [STATE_KEY]: state });
  }

  async function loadState() {
    return new Promise(resolve => {
      chrome.storage.local.get(STATE_KEY, result => {
        if (result[STATE_KEY]) {
          state = { ...state, ...result[STATE_KEY] };
        }
        resolve();
      });
    });
  }

  // Parse reset time from any text containing "resets in X" patterns.
  // Handles all formats seen in the claude.ai meter bar and limit banners:
  //   "resets in 2h 7m"   "resets in 49m"   "resets in 2d 19h"
  //   "Resets 2:00 AM"    "resets in 1h"
  function parseResetTime(text) {
    // Absolute: "Resets 2:00 AM" or "resets at 2:00 AM"
    const absMatch = text.match(/resets?\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (absMatch) {
      let hours = parseInt(absMatch[1], 10);
      const mins = parseInt(absMatch[2], 10);
      const ampm = absMatch[3].toUpperCase();
      if (ampm === 'PM' && hours !== 12) hours += 12;
      if (ampm === 'AM' && hours === 12) hours = 0;
      const reset = new Date();
      reset.setHours(hours, mins, 0, 0);
      if (reset <= new Date()) reset.setDate(reset.getDate() + 1);
      return reset.getTime();
    }

    // Relative days+hours: "resets in 2d 19h"
    const dhMatch = text.match(/resets?\s+in\s+(\d+)d\s+(\d+)h/i);
    if (dhMatch) {
      const d = parseInt(dhMatch[1], 10), h = parseInt(dhMatch[2], 10);
      return Date.now() + (d * 24 * 60 + h * 60) * 60 * 1000;
    }

    // Relative days only: "resets in 2d"
    const dMatch = text.match(/resets?\s+in\s+(\d+)d/i);
    if (dMatch) {
      return Date.now() + parseInt(dMatch[1], 10) * 24 * 60 * 60 * 1000;
    }

    // Relative hours+minutes: "resets in 2h 7m"
    const hmMatch = text.match(/resets?\s+in\s+(\d+)h\s+(\d+)m/i);
    if (hmMatch) {
      const h = parseInt(hmMatch[1], 10), m = parseInt(hmMatch[2], 10);
      return Date.now() + (h * 60 + m) * 60 * 1000;
    }

    // Relative hours only: "resets in 2h"
    const hMatch = text.match(/resets?\s+in\s+(\d+)h/i);
    if (hMatch) {
      return Date.now() + parseInt(hMatch[1], 10) * 60 * 60 * 1000;
    }

    // Relative minutes only: "resets in 49m"
    const mMatch = text.match(/resets?\s+in\s+(\d+)m/i);
    if (mMatch) {
      return Date.now() + parseInt(mMatch[1], 10) * 60 * 1000;
    }

    return null;
  }

  // Scan the meter bar text visible in the claude.ai input area.
  // Returns { sessionReset, weeklyReset } — both optional epoch ms.
  // Example text: "Session: 28% · resets in 2h 7m ... Weekly: 66% · resets in 2d 19h"
  function parseMeterBar() {
    let sessionReset = null, weeklyReset = null;

    // Find all text nodes that contain "resets in"
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent;
      if (!/resets?\s+in/i.test(t) && !/resets?\s+\d/i.test(t)) continue;

      const parsed = parseResetTime(t);
      if (!parsed) continue;

      // Heuristic: session resets sooner, weekly resets later
      if (!sessionReset || parsed < sessionReset) sessionReset = parsed;
      else if (!weeklyReset || parsed > weeklyReset) weeklyReset = parsed;
    }

    return { sessionReset, weeklyReset };
  }

  // Detect limit state. Called on DOM mutations and on a poll interval.
  // Uses two signals:
  //   1. Hard limit banner ("Usage limit reached") → definitely blocked
  //   2. Meter bar "Session: X% · resets in Y" → preemptively show panel
  function detectRateLimit() {
    const bodyText = document.body.innerText || '';

    // ── Signal 1: hard limit banner ──────────────────────────────────────────
    const hardLimitPhrases = [
      'Usage limit reached',
      'usage limit reached',
      "You've reached your",
      'Keep working', // the CTA button text in the banner
    ];
    const isHardLimited = hardLimitPhrases.some(p => bodyText.includes(p));

    // ── Signal 2: meter bar always present ───────────────────────────────────
    const { sessionReset, weeklyReset } = parseMeterBar();

    // Store meter data for display even when not limited
    if (sessionReset) state.sessionReset = sessionReset;
    if (weeklyReset) state.weeklyReset = weeklyReset;

    // Show panel proactively if meter is visible (user can queue ahead of time)
    if ((sessionReset || weeklyReset) && !panelInjected) {
      injectPanel();
    }

    if (isHardLimited && !state.limited) {
      // Pick the soonest reset as the unblock time
      const resetAt = sessionReset || weeklyReset || (Date.now() + 60 * 60 * 1000);
      state.limited = true;
      state.resetAt = resetAt;
      saveState();

      if (!panelInjected) injectPanel();
      updatePanel();

      chrome.runtime.sendMessage({ type: 'SET_ALARM', resetAt });

    } else if (!isHardLimited && state.limited) {
      state.limited = false;
      saveState();
      updatePanel();

      if (state.autoFire && state.queue.filter(q => q.status === 'pending').length > 0 && !firingInProgress) {
        fireQueue();
      }
    } else if (!isHardLimited) {
      // Not limited — still update panel meter display
      updatePanel();
    }
  }

  // ─── Queue Panel UI ───────────────────────────────────────────────────────────

  function injectPanel() {
    if (panelInjected) return;
    panelInjected = true;

    const panel = document.createElement('div');
    panel.id = 'promptq-panel';
    panel.innerHTML = `
      <div id="pq-header">
        <div id="pq-logo">
          <span class="pq-icon">⏱</span>
          <span id="pq-title">promptq</span>
        </div>
        <div id="pq-controls">
          <button id="pq-minimize" title="Minimize">−</button>
          <button id="pq-close" title="Close">×</button>
        </div>
      </div>

      <div id="pq-body">
        <div id="pq-status-bar">
          <span class="pq-dot" id="pq-dot"></span>
          <span id="pq-status-text">Watching...</span>
          <span id="pq-countdown"></span>
        </div>
        <div id="pq-meter-row" style="display:none"></div>

        <div id="pq-queue-section">
          <div id="pq-queue-list"></div>
          <div id="pq-empty" style="display:none">
            <p>No prompts queued.<br>Add one below to keep your flow.</p>
          </div>
        </div>

        <div id="pq-add-section">
          <textarea id="pq-input" placeholder="What do you want to ask next? (Cmd+Enter to add)" rows="3"></textarea>
          <div id="pq-add-row">
            <span id="pq-queue-count">0 queued</span>
            <button id="pq-add-btn">+ Add</button>
          </div>
        </div>

        <div id="pq-footer">
          <label class="pq-toggle-row" title="Automatically fire prompts when limit resets">
            <input type="checkbox" id="pq-autofire" ${state.autoFire ? 'checked' : ''}>
            <span>Auto-fire on reset</span>
          </label>
          <label class="pq-toggle-row" title="Wait for each response before sending next prompt">
            <input type="checkbox" id="pq-wait" ${state.waitForResponse ? 'checked' : ''}>
            <span>Wait for response</span>
          </label>
          <div id="pq-fire-row">
            <button id="pq-fire-btn" disabled>Fire Queue Now</button>
            <button id="pq-clear-btn">Clear All</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    // Make draggable
    makeDraggable(panel, document.getElementById('pq-header'));

    // Wire up events
    document.getElementById('pq-minimize').addEventListener('click', toggleMinimize);
    document.getElementById('pq-close').addEventListener('click', () => {
      panel.style.display = 'none';
    });
    document.getElementById('pq-add-btn').addEventListener('click', addPrompt);
    document.getElementById('pq-input').addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') addPrompt();
    });
    document.getElementById('pq-autofire').addEventListener('change', e => {
      state.autoFire = e.target.checked;
      saveState();
    });
    document.getElementById('pq-wait').addEventListener('change', e => {
      state.waitForResponse = e.target.checked;
      saveState();
    });
    document.getElementById('pq-fire-btn').addEventListener('click', fireQueue);
    document.getElementById('pq-clear-btn').addEventListener('click', () => {
      state.queue = [];
      saveState();
      renderQueueList();
    });

    renderQueueList();
    startCountdown();
  }

  function toggleMinimize() {
    const body = document.getElementById('pq-body');
    const btn = document.getElementById('pq-minimize');
    if (body.style.display === 'none') {
      body.style.display = '';
      btn.textContent = '−';
    } else {
      body.style.display = 'none';
      btn.textContent = '+';
    }
  }

  function makeDraggable(el, handle) {
    let ox = 0, oy = 0, sx = 0, sy = 0;
    handle.style.cursor = 'grab';
    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      sx = e.clientX; sy = e.clientY;
      const rect = el.getBoundingClientRect();
      ox = rect.left; oy = rect.top;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      el.style.left = ox + 'px';
      el.style.top = oy + 'px';
      handle.style.cursor = 'grabbing';

      const onMove = e => {
        const dx = e.clientX - sx, dy = e.clientY - sy;
        el.style.left = Math.max(0, ox + dx) + 'px';
        el.style.top = Math.max(0, oy + dy) + 'px';
      };
      const onUp = () => {
        handle.style.cursor = 'grab';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function addPrompt() {
    const input = document.getElementById('pq-input');
    const text = input.value.trim();
    if (!text) return;
    state.queue.push({ id: Date.now(), text, status: 'pending' });
    input.value = '';
    saveState();
    renderQueueList();
  }

  function renderQueueList() {
    const list = document.getElementById('pq-queue-list');
    const empty = document.getElementById('pq-empty');
    const count = document.getElementById('pq-queue-count');
    const fireBtn = document.getElementById('pq-fire-btn');

    if (!list) return;

    const pending = state.queue.filter(q => q.status === 'pending');
    count.textContent = `${pending.length} queued`;
    fireBtn.disabled = pending.length === 0 || firingInProgress;

    if (state.queue.length === 0) {
      list.innerHTML = '';
      empty.style.display = '';
      return;
    }
    empty.style.display = 'none';

    list.innerHTML = state.queue.map((item, i) => `
      <div class="pq-item pq-status-${item.status}" data-id="${item.id}">
        <div class="pq-item-pos">${i + 1}</div>
        <div class="pq-item-text">${escapeHtml(item.text)}</div>
        <div class="pq-item-actions">
          ${item.status === 'pending' ? `
            <button class="pq-move-up" data-idx="${i}" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="pq-move-down" data-idx="${i}" title="Move down" ${i === state.queue.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="pq-remove" data-idx="${i}" title="Remove">×</button>
          ` : `<span class="pq-badge pq-badge-${item.status}">${item.status}</span>`}
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.pq-move-up').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        if (idx > 0) {
          [state.queue[idx - 1], state.queue[idx]] = [state.queue[idx], state.queue[idx - 1]];
          saveState(); renderQueueList();
        }
      });
    });
    list.querySelectorAll('.pq-move-down').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        if (idx < state.queue.length - 1) {
          [state.queue[idx], state.queue[idx + 1]] = [state.queue[idx + 1], state.queue[idx]];
          saveState(); renderQueueList();
        }
      });
    });
    list.querySelectorAll('.pq-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        state.queue.splice(idx, 1);
        saveState(); renderQueueList();
      });
    });
  }

  function updatePanel() {
    const dot = document.getElementById('pq-dot');
    const statusText = document.getElementById('pq-status-text');
    const meterRow = document.getElementById('pq-meter-row');
    if (!dot || !statusText) return;

    if (state.limited) {
      dot.className = 'pq-dot pq-dot-red';
      statusText.textContent = 'Limit active — queue your prompts';
    } else if (firingInProgress) {
      dot.className = 'pq-dot pq-dot-blue';
      statusText.textContent = 'Firing queued prompts...';
    } else {
      dot.className = 'pq-dot pq-dot-green';
      statusText.textContent = 'Limit clear';
    }

    // Update meter row with session + weekly reset times
    if (meterRow) {
      const parts = [];
      if (state.sessionReset) {
        const ms = state.sessionReset - Date.now();
        parts.push(`Session resets in ${formatMs(ms)}`);
      }
      if (state.weeklyReset) {
        const ms = state.weeklyReset - Date.now();
        parts.push(`Weekly resets in ${formatMs(ms)}`);
      }
      meterRow.textContent = parts.join('  ·  ');
      meterRow.style.display = parts.length ? '' : 'none';
    }
  }

  function formatMs(ms) {
    if (ms <= 0) return 'now';
    const d = Math.floor(ms / 86400000);
    const h = Math.floor((ms % 86400000) / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function startCountdown() {
    setInterval(() => {
      const countdown = document.getElementById('pq-countdown');
      if (!countdown) return;
      if (!state.limited || !state.resetAt) {
        countdown.textContent = '';
        return;
      }
      const ms = state.resetAt - Date.now();
      countdown.textContent = ms <= 0 ? 'resetting...' : formatMs(ms);
      // Also refresh meter row
      updatePanel();
    }, 1000);
  }

  function escapeHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ─── Firing Logic ─────────────────────────────────────────────────────────────

  async function fireQueue() {
    if (firingInProgress) return;
    const pending = state.queue.filter(q => q.status === 'pending');
    if (pending.length === 0) return;

    firingInProgress = true;
    updatePanel();
    renderQueueList();

    for (const item of pending) {
      item.status = 'sending';
      saveState();
      renderQueueList();

      const success = await submitPrompt(item.text);

      item.status = success ? 'done' : 'failed';
      saveState();
      renderQueueList();

      if (!success) break;

      if (state.waitForResponse) {
        await waitForResponse();
      }

      // Delay between prompts
      if (pending.indexOf(item) < pending.length - 1) {
        await sleep(state.delayBetween);
      }
    }

    firingInProgress = false;
    updatePanel();
    renderQueueList();

    const doneCount = state.queue.filter(q => q.status === 'done').length;
    chrome.runtime.sendMessage({
      type: 'NOTIFY',
      title: 'promptq — queue complete',
      message: `${doneCount} prompt${doneCount !== 1 ? 's' : ''} fired successfully.`,
    });
  }

  async function submitPrompt(text) {
    try {
      // Find the claude.ai textarea
      const textarea = findTextarea();
      if (!textarea) {
        console.warn('[promptq] Could not find textarea');
        return false;
      }

      // Focus and set value using React's internal setter
      textarea.focus();
      await sleep(200);

      // React synthetic event approach
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )?.set || Object.getOwnPropertyDescriptor(
        window.HTMLElement.prototype, 'innerText'
      )?.set;

      // Try contenteditable first (claude.ai uses a div[contenteditable])
      const editable = findContentEditable();
      if (editable) {
        editable.focus();
        await sleep(100);
        editable.innerText = text;
        editable.dispatchEvent(new Event('input', { bubbles: true }));
        editable.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(300);
        const submitBtn = findSubmitButton();
        if (submitBtn) {
          submitBtn.click();
          return true;
        }
        // Fallback: Enter key
        editable.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        return true;
      }

      // Plain textarea fallback
      if (textarea && nativeInputValueSetter) {
        nativeInputValueSetter.call(textarea, text);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(300);
        const submitBtn = findSubmitButton();
        if (submitBtn) { submitBtn.click(); return true; }
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        return true;
      }

      return false;
    } catch (err) {
      console.error('[promptq] submitPrompt error:', err);
      return false;
    }
  }

  function findTextarea() {
    return document.querySelector('textarea[placeholder]') ||
           document.querySelector('textarea') ||
           null;
  }

  function findContentEditable() {
    // claude.ai uses a ProseMirror div
    return document.querySelector('div[contenteditable="true"]') ||
           document.querySelector('[role="textbox"]') ||
           null;
  }

  function findSubmitButton() {
    // Look for send/submit button near the input area
    const selectors = [
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
      'button[type="submit"]',
      'button[data-testid*="send"]',
    ];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled) return btn;
    }
    // Fallback: last enabled button in the input container
    const buttons = [...document.querySelectorAll('button')].filter(b => !b.disabled);
    return buttons[buttons.length - 1] || null;
  }

  async function waitForResponse() {
    // Wait for a "thinking" state then wait for it to clear
    await sleep(1000);
    const maxWait = 5 * 60 * 1000; // 5 min max
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const isThinking = document.querySelector(
        '[data-is-streaming], .thinking, [aria-label*="thinking"], [aria-label*="Loading"]'
      );
      if (!isThinking) break;
      await sleep(1000);
    }
    // Extra buffer after response completes
    await sleep(1500);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ─── Background message listener ─────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'LIMIT_RESET') {
      state.limited = false;
      saveState();
      updatePanel();
      if (state.autoFire && state.queue.filter(q => q.status === 'pending').length > 0) {
        fireQueue();
      }
    }
    if (msg.type === 'OPEN_PANEL') {
      if (!panelInjected) injectPanel();
      const panel = document.getElementById('promptq-panel');
      if (panel) panel.style.display = '';
    }
  });

  // ─── DOM Observer ─────────────────────────────────────────────────────────────

  function startObserver() {
    observer = new MutationObserver(() => {
      detectRateLimit();
      if (panelInjected) renderQueueList();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    // Also poll every 5s as a safety net
    setInterval(detectRateLimit, 5000);
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────

  async function init() {
    await loadState();
    detectRateLimit();
    startObserver();

    // If we were previously limited and have queued items, show panel
    if (state.limited || state.queue.length > 0) {
      if (!panelInjected) injectPanel();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

