(() => {
  'use strict';

  // ─── Constants ────────────────────────────────────────────────────────────────
  const STATE_KEY = 'promptq_state';
  const POLL_MS   = 500;   // how often we check button state
  const LOG       = (...a) => console.log('[promptq]', ...a);

  // ─── App state ────────────────────────────────────────────────────────────────
  let state = {
    queue: [],
    autoFire: true,
    waitForResponse: true,
    delayBetween: 800,
    // runtime only (not persisted across page loads):
    limited: false,
    resetAt: null,
    sessionReset: null,
    weeklyReset: null,
  };

  // ─── Machine state ────────────────────────────────────────────────────────────
  // IDLE | STREAMING | LIMITED | FIRING
  let machineState = 'IDLE';
  let panelInjected = false;
  let observerStarted = false;

  // ─── Persistence ──────────────────────────────────────────────────────────────
  function saveState() {
    const { queue, autoFire, waitForResponse, delayBetween } = state;
    chrome.storage.local.set({ [STATE_KEY]: { queue, autoFire, waitForResponse, delayBetween } });
  }

  async function loadState() {
    return new Promise(resolve => {
      chrome.storage.local.get(STATE_KEY, result => {
        if (result[STATE_KEY]) state = { ...state, ...result[STATE_KEY] };
        resolve();
      });
    });
  }

  // ─── Submit button helpers ────────────────────────────────────────────────────
  // The orange arrow button is the ground truth for "Claude is ready".
  // When streaming: button shows stop icon, aria-label contains "Stop"/"Cancel".
  // When ready:     button shows arrow, aria-label contains "Send", not disabled.

  function getSendButton() {
    // Specific selectors first
    for (const sel of [
      'button[aria-label="Send message"]',
      'button[aria-label="Send Message"]',
      'button[data-testid="send-button"]',
    ]) {
      const b = document.querySelector(sel);
      if (b) return b;
    }
    // Broader: enabled buttons near the composer
    const all = [...document.querySelectorAll('form button, [role="textbox"] ~ * button')];
    return all.filter(b => !b.disabled).pop() || null;
  }

  function getStopButton() {
    return document.querySelector(
      'button[aria-label*="Stop"], button[aria-label*="stop"], button[aria-label*="Cancel"]'
    );
  }

  function isArrowReady() {
    // Orange arrow visible and enabled → Claude is idle
    if (getStopButton()) return false;                         // stop icon = still going
    if (document.querySelector('[data-is-streaming="true"]')) return false;
    const btn = getSendButton();
    if (!btn || btn.disabled) return false;
    const lbl = (btn.getAttribute('aria-label') || '').toLowerCase();
    if (lbl.includes('stop') || lbl.includes('cancel')) return false;
    return true;
  }

  function isStreaming() {
    if (getStopButton()) return true;
    if (document.querySelector('[data-is-streaming="true"]')) return true;
    const btn = getSendButton();
    return !!(btn && btn.disabled);
  }

  // Poll until the orange arrow is ready, or timeout.
  async function waitForArrow(maxMs = 10 * 60 * 1000) {
    const deadline = Date.now() + maxMs;
    await sleep(1500); // give streaming a beat to start
    while (Date.now() < deadline) {
      if (isArrowReady()) return true;
      await sleep(POLL_MS);
    }
    return false;
  }

  // ─── Rate limit detection ─────────────────────────────────────────────────────
  function parseResetTime(text) {
    const t = text || '';
    const abs = t.match(/resets?\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (abs) {
      let h = parseInt(abs[1], 10), m = parseInt(abs[2], 10);
      const ap = abs[3].toUpperCase();
      if (ap === 'PM' && h !== 12) h += 12;
      if (ap === 'AM' && h === 12) h = 0;
      const d = new Date(); d.setHours(h, m, 0, 0);
      if (d <= new Date()) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
    const dh = t.match(/resets?\s+in\s+(\d+)d\s+(\d+)h/i);
    if (dh) return Date.now() + (parseInt(dh[1])*24*60 + parseInt(dh[2])*60)*60000;
    const d2 = t.match(/resets?\s+in\s+(\d+)d/i);
    if (d2) return Date.now() + parseInt(d2[1])*86400000;
    const hm = t.match(/resets?\s+in\s+(\d+)h\s+(\d+)m/i);
    if (hm) return Date.now() + (parseInt(hm[1])*60 + parseInt(hm[2]))*60000;
    const h2 = t.match(/resets?\s+in\s+(\d+)h/i);
    if (h2) return Date.now() + parseInt(h2[1])*3600000;
    const m2 = t.match(/resets?\s+in\s+(\d+)m/i);
    if (m2) return Date.now() + parseInt(m2[1])*60000;
    return null;
  }

  function parseMeterBar() {
    const resets = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent;
      if (!/resets?\s+in/i.test(t) && !/resets?\s+\d/i.test(t)) continue;
      const parsed = parseResetTime(t);
      if (parsed) resets.push(parsed);
    }
    resets.sort((a, b) => a - b);
    return { sessionReset: resets[0] || null, weeklyReset: resets[1] || null };
  }

  function isHardLimited() {
    const body = document.body.innerText || '';
    return ['Usage limit reached', "You've reached your", 'Keep working'].some(p => body.includes(p));
  }

  // ─── State machine transition ─────────────────────────────────────────────────
  function transition(next) {
    if (machineState === next) return;
    LOG(`${machineState} → ${next}`);
    machineState = next;
    updatePanel();
  }

  // ─── The main loop ────────────────────────────────────────────────────────────
  // Called on every DOM mutation + every 5s poll.
  // Determines which state we're in and kicks off firing if needed.
  let loopRunning = false;

  async function tick() {
    if (loopRunning) return;
    loopRunning = true;

    try {
      const { sessionReset, weeklyReset } = parseMeterBar();
      if (sessionReset) state.sessionReset = sessionReset;
      if (weeklyReset)  state.weeklyReset  = weeklyReset;

      const limited   = isHardLimited();
      const streaming = isStreaming();
      const arrowUp   = isArrowReady();

      // Show panel whenever we can see the meter bar (user can queue ahead of time)
      if ((sessionReset || weeklyReset || limited) && !panelInjected) {
        injectPanel();
      }

      // ── Transitions ──────────────────────────────────────────────────────────
      if (limited) {
        // Hard wall — tell background to set alarm for reset time
        if (machineState !== 'LIMITED') {
          const resetAt = sessionReset || weeklyReset || (Date.now() + 3600000);
          state.limited = true;
          state.resetAt = resetAt;
          chrome.runtime.sendMessage({ type: 'SET_ALARM', resetAt });
          transition('LIMITED');
        }

      } else if (streaming) {
        if (machineState === 'LIMITED') {
          // Limit just cleared and Claude is already responding
          state.limited = false;
          transition('STREAMING');
        } else if (machineState !== 'STREAMING' && machineState !== 'FIRING') {
          transition('STREAMING');
        }

      } else if (arrowUp) {
        if (machineState === 'LIMITED') {
          // Limit lifted, arrow is up
          state.limited = false;
        }
        if (machineState !== 'FIRING') {
          const pending = state.queue.filter(q => q.status === 'pending');
          if (pending.length > 0 && state.autoFire) {
            transition('FIRING');
            loopRunning = false;
            await fireQueue();
            return;
          } else {
            transition('IDLE');
          }
        }
      }

      updatePanel();
    } finally {
      loopRunning = false;
    }
  }

  // ─── Firing logic ─────────────────────────────────────────────────────────────
  async function fireQueue() {
    const pending = state.queue.filter(q => q.status === 'pending');
    if (pending.length === 0) { transition('IDLE'); return; }

    LOG(`firing ${pending.length} queued prompts`);

    for (const item of pending) {
      item.status = 'sending';
      saveState();
      renderQueueList();

      const ok = await submitPrompt(item.text);

      item.status = ok ? 'done' : 'failed';
      saveState();
      renderQueueList();

      if (!ok) {
        LOG('submit failed, stopping queue');
        break;
      }

      // Wait for the arrow to come back (Claude finished responding)
      if (state.waitForResponse) {
        transition('STREAMING');
        const ready = await waitForArrow();
        if (!ready) {
          LOG('timed out waiting for arrow');
          break;
        }
        transition('FIRING');
        await sleep(state.delayBetween);
      } else {
        await sleep(state.delayBetween);
      }
    }

    const done = state.queue.filter(q => q.status === 'done').length;
    chrome.runtime.sendMessage({
      type: 'NOTIFY',
      title: 'promptq — queue complete',
      message: `${done} prompt${done !== 1 ? 's' : ''} fired.`,
    });

    transition('IDLE');
    updatePanel();
    renderQueueList();
  }

  // ─── Input injection ──────────────────────────────────────────────────────────
  async function submitPrompt(text) {
    try {
      // Wait for arrow before doing anything
      if (!isArrowReady()) {
        const ready = await waitForArrow();
        if (!ready) return false;
      }

      // ProseMirror contenteditable (current claude.ai)
      const editable = document.querySelector('div[contenteditable="true"], [role="textbox"]');
      if (editable) {
        editable.focus();
        await sleep(100);

        // Clear + set text via execCommand (most compatible with ProseMirror)
        editable.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        await sleep(50);
        document.execCommand('insertText', false, text);
        await sleep(250);

        // Click the send button
        const btn = getSendButton();
        if (btn && !btn.disabled) {
          btn.click();
          LOG('sent via button click');
          return true;
        }

        // Fallback: Enter key
        editable.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true
        }));
        return true;
      }

      // Textarea fallback
      const ta = document.querySelector('textarea');
      if (ta) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) {
          setter.call(ta, text);
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(200);
          const btn = getSendButton();
          if (btn && !btn.disabled) { btn.click(); return true; }
          ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
          return true;
        }
      }

      LOG('no input element found');
      return false;
    } catch (err) {
      LOG('submitPrompt error:', err);
      return false;
    }
  }

  // ─── Panel UI ─────────────────────────────────────────────────────────────────
  function injectPanel() {
    if (panelInjected) return;
    panelInjected = true;

    const panel = document.createElement('div');
    panel.id = 'promptq-panel';
    panel.innerHTML = `
      <div id="pq-header">
        <div id="pq-logo"><span class="pq-icon">⏱</span><span id="pq-title">promptq</span></div>
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
          <div id="pq-empty">No prompts queued.<br>Add one below to keep your flow.</div>
        </div>
        <div id="pq-add-section">
          <textarea id="pq-input" placeholder="What do you want to ask next? (Cmd+Enter to add)" rows="3"></textarea>
          <div id="pq-add-row">
            <span id="pq-queue-count">0 queued</span>
            <button id="pq-add-btn">+ Add</button>
          </div>
        </div>
        <div id="pq-footer">
          <label class="pq-toggle-row" title="Auto-fire queued prompts when Claude is ready">
            <input type="checkbox" id="pq-autofire" ${state.autoFire ? 'checked' : ''}>
            <span>Auto-fire when ready</span>
          </label>
          <label class="pq-toggle-row" title="Wait for each response before sending the next prompt">
            <input type="checkbox" id="pq-wait" ${state.waitForResponse ? 'checked' : ''}>
            <span>Wait for response</span>
          </label>
          <div id="pq-fire-row">
            <button id="pq-fire-btn">Fire Queue Now</button>
            <button id="pq-clear-btn">Clear All</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(panel);
    makeDraggable(panel, document.getElementById('pq-header'));

    document.getElementById('pq-minimize').addEventListener('click', () => {
      const body = document.getElementById('pq-body');
      const btn  = document.getElementById('pq-minimize');
      const hidden = body.style.display === 'none';
      body.style.display = hidden ? '' : 'none';
      btn.textContent = hidden ? '−' : '+';
    });
    document.getElementById('pq-close').addEventListener('click', () => {
      panel.style.display = 'none';
    });
    document.getElementById('pq-add-btn').addEventListener('click', addPrompt);
    document.getElementById('pq-input').addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') addPrompt();
    });
    document.getElementById('pq-autofire').addEventListener('change', e => {
      state.autoFire = e.target.checked; saveState();
    });
    document.getElementById('pq-wait').addEventListener('change', e => {
      state.waitForResponse = e.target.checked; saveState();
    });
    document.getElementById('pq-fire-btn').addEventListener('click', () => {
      if (machineState !== 'FIRING') { transition('FIRING'); fireQueue(); }
    });
    document.getElementById('pq-clear-btn').addEventListener('click', () => {
      state.queue = []; saveState(); renderQueueList();
    });

    renderQueueList();
    updatePanel();
    startCountdown();
  }

  function addPrompt() {
    const input = document.getElementById('pq-input');
    const text  = (input?.value || '').trim();
    if (!text) return;
    state.queue.push({ id: Date.now(), text, status: 'pending' });
    input.value = '';
    saveState();
    renderQueueList();
  }

  function renderQueueList() {
    const list   = document.getElementById('pq-queue-list');
    const empty  = document.getElementById('pq-empty');
    const count  = document.getElementById('pq-queue-count');
    const fireBtn = document.getElementById('pq-fire-btn');
    if (!list) return;

    const pending = state.queue.filter(q => q.status === 'pending');
    if (count)   count.textContent  = `${pending.length} queued`;
    if (fireBtn) fireBtn.disabled   = pending.length === 0 || machineState === 'FIRING';

    if (state.queue.length === 0) {
      list.innerHTML = '';
      if (empty) empty.style.display = '';
      return;
    }
    if (empty) empty.style.display = 'none';

    list.innerHTML = state.queue.map((item, i) => `
      <div class="pq-item pq-status-${item.status}" data-idx="${i}">
        <div class="pq-item-pos">${i + 1}</div>
        <div class="pq-item-text">${escHtml(item.text)}</div>
        <div class="pq-item-actions">
          ${item.status === 'pending' ? `
            <button class="pq-move-up"   data-idx="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="pq-move-down" data-idx="${i}" ${i === state.queue.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="pq-remove"    data-idx="${i}">×</button>
          ` : `<span class="pq-badge pq-badge-${item.status}">${item.status}</span>`}
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.pq-move-up').forEach(b => b.addEventListener('click', () => {
      const i = +b.dataset.idx;
      if (i > 0) { [state.queue[i-1], state.queue[i]] = [state.queue[i], state.queue[i-1]]; saveState(); renderQueueList(); }
    }));
    list.querySelectorAll('.pq-move-down').forEach(b => b.addEventListener('click', () => {
      const i = +b.dataset.idx;
      if (i < state.queue.length - 1) { [state.queue[i], state.queue[i+1]] = [state.queue[i+1], state.queue[i]]; saveState(); renderQueueList(); }
    }));
    list.querySelectorAll('.pq-remove').forEach(b => b.addEventListener('click', () => {
      state.queue.splice(+b.dataset.idx, 1); saveState(); renderQueueList();
    }));
  }

  function updatePanel() {
    const dot        = document.getElementById('pq-dot');
    const statusText = document.getElementById('pq-status-text');
    const meterRow   = document.getElementById('pq-meter-row');
    if (!dot || !statusText) return;

    const labels = {
      IDLE:      ['pq-dot-green', 'Ready'],
      STREAMING: ['pq-dot-blue',  'Claude is responding...'],
      LIMITED:   ['pq-dot-red',   'Limit active — queue your prompts'],
      FIRING:    ['pq-dot-blue',  'Firing queued prompts...'],
    };
    const [cls, text] = labels[machineState] || ['', 'Watching...'];
    dot.className = `pq-dot ${cls}`;
    statusText.textContent = text;

    // Meter bar
    if (meterRow) {
      const parts = [];
      if (state.sessionReset) parts.push(`Session resets in ${formatMs(state.sessionReset - Date.now())}`);
      if (state.weeklyReset)  parts.push(`Weekly resets in ${formatMs(state.weeklyReset  - Date.now())}`);
      meterRow.textContent   = parts.join('  ·  ');
      meterRow.style.display = parts.length ? '' : 'none';
    }
  }

  function startCountdown() {
    setInterval(() => {
      const el = document.getElementById('pq-countdown');
      if (!el) return;
      if (machineState !== 'LIMITED' || !state.resetAt) { el.textContent = ''; return; }
      const ms = state.resetAt - Date.now();
      el.textContent = ms <= 0 ? 'resetting...' : formatMs(ms);
      updatePanel(); // keep meter row fresh too
    }, 1000);
  }

  function formatMs(ms) {
    if (ms <= 0) return 'now';
    const d = Math.floor(ms / 86400000);
    const h = Math.floor((ms % 86400000) / 3600000);
    const m = Math.floor((ms % 3600000)  / 60000);
    const s = Math.floor((ms % 60000)    / 1000);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function makeDraggable(el, handle) {
    let ox = 0, oy = 0, sx = 0, sy = 0;
    handle.style.cursor = 'grab';
    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect();
      ox = r.left; oy = r.top;
      el.style.right = 'auto'; el.style.bottom = 'auto';
      el.style.left = ox + 'px'; el.style.top = oy + 'px';
      handle.style.cursor = 'grabbing';
      const move = e => {
        el.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
        el.style.top  = Math.max(0, oy + e.clientY - sy) + 'px';
      };
      const up = () => { handle.style.cursor = 'grab'; document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ─── Background messages ──────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'LIMIT_RESET') {
      state.limited = false;
      // Don't force transition here — let tick() handle it on next poll
      tick();
    }
    if (msg.type === 'OPEN_PANEL') {
      if (!panelInjected) injectPanel();
      const p = document.getElementById('promptq-panel');
      if (p) p.style.display = '';
    }
  });

  // ─── Observer + polling ───────────────────────────────────────────────────────
  function startObserver() {
    if (observerStarted) return;
    observerStarted = true;

    // DOM mutation → tick
    new MutationObserver(() => tick()).observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['aria-label', 'disabled', 'data-is-streaming'],
    });

    // Safety poll every 5s
    setInterval(tick, 5000);
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────
  async function init() {
    await loadState();
    startObserver();
    tick();

    // If there are queued items from a previous session, show the panel
    if (state.queue.length > 0 && !panelInjected) injectPanel();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
