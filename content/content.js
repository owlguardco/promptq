(() => {
  'use strict';

  const LOG = (...a) => console.log('[promptq]', ...a);
  LOG('content script loaded', location.href);

  const STATE_KEY = 'promptq_state';
  const POLL_MS   = 500;

  let state = {
    queue: [],
    autoFire: true,
    waitForResponse: true,
    delayBetween: 800,
    limited: false,
    resetAt: null,
    sessionReset: null,
    weeklyReset: null,
  };

  let machineState  = 'IDLE';
  let uiInjected    = false;
  let panelOpen     = false;
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

  // ─── Submit button ────────────────────────────────────────────────────────────
  function getSendButton() {
    // Try known aria-labels / testids first, then broad wildcard matches.
    for (const sel of [
      'button[aria-label="Send message"]',
      'button[aria-label="Send Message"]',
      'button[data-testid="send-button"]',
      'button[aria-label*="send" i]',
      'button[data-testid*="send"]',
    ]) {
      const b = document.querySelector(sel);
      if (b) return b;
    }
    // Fallback: walk up from the contenteditable and find a button sibling/cousin
    // that is not disabled and has an SVG child (the arrow icon). Prefer those;
    // otherwise return the last enabled button found at that level.
    const editable = document.querySelector('div[contenteditable="true"]');
    if (editable) {
      let el = editable.parentElement;
      while (el && el !== document.body) {
        const btns = [...el.querySelectorAll('button')].filter(b => !b.disabled);
        const withSvg = btns.filter(b => b.querySelector('svg'));
        if (withSvg.length) return withSvg[withSvg.length - 1];
        if (btns.length) return btns[btns.length - 1];
        el = el.parentElement;
      }
    }
    return null;
  }

  function getStopButton() {
    return document.querySelector(
      'button[aria-label*="Stop"], button[aria-label*="stop"], button[aria-label*="Cancel"]'
    );
  }

  function isArrowReady() {
    if (getStopButton()) return false;
    if (document.querySelector('[data-is-streaming="true"]')) return false;
    const btn = getSendButton();
    if (!btn || btn.disabled) return false;
    const lbl = (btn.getAttribute('aria-label') || '').toLowerCase();
    return !lbl.includes('stop') && !lbl.includes('cancel');
  }

  function isStreaming() {
    if (getStopButton()) return true;
    if (document.querySelector('[data-is-streaming="true"]')) return true;
    const btn = getSendButton();
    return !!(btn && btn.disabled);
  }

  async function waitForArrow(maxMs = 10 * 60 * 1000) {
    const deadline = Date.now() + maxMs;
    await sleep(1500);
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
      if (!/resets?\s+in/i.test(t)) continue;
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

  // ─── Composer container detection ─────────────────────────────────────────────
  // Strategy: anchor on the contenteditable input ALONE — the send button is often
  // absent on an idle/empty composer, so requiring it meant the strip never mounted.
  // Walk up a few levels from the input and pick the widest ancestor that is still
  // inside the page's main column (never <body>/<html>). Inject our wrapper before it.
  function findComposerAnchor() {
    const editable = document.querySelector('div[contenteditable="true"], [role="textbox"]');
    if (!editable) return null;

    // Walk up 3–4 levels, tracking the widest ancestor that stays inside the main
    // column. Stop before <body>/<html> so the strip lands in the content flow.
    let best = editable.parentElement;
    let el   = editable.parentElement;
    for (let i = 0; i < 4 && el && el.parentElement; i++) {
      const next = el.parentElement;
      if (next === document.body || next === document.documentElement) break;
      if (el.getBoundingClientRect().width >= best.getBoundingClientRect().width) best = el;
      el = next;
    }

    if (!best || !best.parentElement) return null;
    return { composer: best, parent: best.parentElement };
  }

  // ─── State machine ────────────────────────────────────────────────────────────
  function transition(next) {
    if (machineState === next) return;
    LOG(`${machineState} → ${next}`);
    machineState = next;
    updateUI();
  }

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

      // Inject as soon as the composer is in the DOM
      if (!uiInjected) injectUI();

      if (limited) {
        if (machineState !== 'LIMITED') {
          const resetAt = sessionReset || weeklyReset || (Date.now() + 3600000);
          state.limited = true;
          state.resetAt = resetAt;
          chrome.runtime.sendMessage({ type: 'SET_ALARM', resetAt });
          transition('LIMITED');
        }
      } else if (streaming) {
        if (machineState !== 'STREAMING' && machineState !== 'FIRING') {
          transition('STREAMING');
        }
      } else if (arrowUp) {
        if (machineState === 'LIMITED') state.limited = false;
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
      updateUI();
    } finally {
      loopRunning = false;
    }
  }

  // ─── Firing ───────────────────────────────────────────────────────────────────
  async function fireQueue() {
    const pending = state.queue.filter(q => q.status === 'pending');
    if (!pending.length) { transition('IDLE'); return; }
    LOG(`firing ${pending.length} prompts`);

    for (const item of pending) {
      item.status = 'sending';
      saveState(); renderQueueList();

      const ok = await submitPrompt(item.text);
      item.status = ok ? 'done' : 'failed';
      saveState(); renderQueueList();

      if (!ok) { LOG('submit failed, stopping'); break; }

      if (state.waitForResponse) {
        transition('STREAMING');
        const ready = await waitForArrow();
        if (!ready) { LOG('arrow timed out'); break; }
        transition('FIRING');
        await sleep(state.delayBetween);
      } else {
        await sleep(state.delayBetween);
      }
    }

    const done = state.queue.filter(q => q.status === 'done').length;
    chrome.runtime.sendMessage({
      type: 'NOTIFY',
      title: 'promptq — done',
      message: `${done} prompt${done !== 1 ? 's' : ''} fired.`,
    });
    transition('IDLE');
    renderQueueList();
  }

  // ─── Submit ───────────────────────────────────────────────────────────────────
  async function submitPrompt(text) {
    try {
      if (!isArrowReady()) {
        const ready = await waitForArrow();
        if (!ready) return false;
      }
      const editable = document.querySelector('div[contenteditable="true"], [role="textbox"]');
      if (editable) {
        editable.focus();
        await sleep(100);
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        await sleep(50);
        document.execCommand('insertText', false, text);
        await sleep(250);
        const btn = getSendButton();
        if (btn && !btn.disabled) { btn.click(); return true; }
        editable.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', keyCode: 13, bubbles: true, cancelable: true
        }));
        return true;
      }
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
      return false;
    } catch (err) {
      LOG('submitPrompt error:', err);
      return false;
    }
  }

  // ─── UI injection ─────────────────────────────────────────────────────────────
  function injectUI() {
    if (uiInjected) return;

    const anchor = findComposerAnchor();
    if (!anchor) return; // composer not in DOM yet — tick() will retry

    uiInjected = true;
    LOG('injecting UI');

    // Wrapper holds both panel + strip, inserted before the composer
    const wrapper = document.createElement('div');
    wrapper.id = 'promptq-wrapper';

    // Panel (hidden until toggled)
    const panel = document.createElement('div');
    panel.id = 'promptq-panel';
    panel.innerHTML = `
      <div id="pq-head">
        <div id="pq-logo">⏱ promptq</div>
        <div id="pq-controls">
          <button id="pq-close" title="Collapse">×</button>
        </div>
      </div>
      <div id="pq-body">
        <div id="pq-status-bar">
          <span class="pq-dot" id="pq-dot"></span>
          <span id="pq-status-text">Ready</span>
          <span id="pq-countdown"></span>
        </div>
        <div id="pq-meter-row"></div>
        <div id="pq-queue-section">
          <div id="pq-queue-list"></div>
          <div id="pq-empty">No prompts queued yet.<br>Add one below to keep your flow.</div>
        </div>
        <div id="pq-add-section">
          <textarea id="pq-input" placeholder="Queue your next prompt... (Cmd+Enter to add)" rows="3"></textarea>
          <div id="pq-add-row">
            <span id="pq-queue-count">0 queued</span>
            <button id="pq-add-btn">+ Add</button>
          </div>
        </div>
        <div id="pq-footer">
          <label class="pq-toggle-row">
            <input type="checkbox" id="pq-autofire" ${state.autoFire ? 'checked' : ''}>
            <span>Auto-fire when ready</span>
          </label>
          <label class="pq-toggle-row">
            <input type="checkbox" id="pq-wait" ${state.waitForResponse ? 'checked' : ''}>
            <span>Wait for response</span>
          </label>
          <div id="pq-fire-row">
            <button id="pq-fire-btn">Fire queue now</button>
            <button id="pq-clear-btn">Clear all</button>
          </div>
        </div>
      </div>
    `;

    // Strip (always visible)
    const strip = document.createElement('div');
    strip.id = 'promptq-strip';
    strip.innerHTML = `
      <div id="pq-strip-dot"></div>
      <span id="pq-strip-label">promptq</span>
      <span id="pq-strip-status">Ready</span>
      <span id="pq-strip-count" class="hidden">0</span>
      <span id="pq-strip-chevron">▲</span>
    `;

    wrapper.appendChild(panel);
    wrapper.appendChild(strip);

    // Insert wrapper before the composer element
    anchor.parent.insertBefore(wrapper, anchor.composer);

    // ── Wire events ──
    strip.addEventListener('click', togglePanel);
    document.getElementById('pq-close').addEventListener('click', e => {
      e.stopPropagation(); closePanel();
    });
    document.getElementById('pq-add-btn').addEventListener('click', addPrompt);
    document.getElementById('pq-input').addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); addPrompt(); }
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
    updateUI();
    startCountdown();

    if (state.queue.length > 0) openPanel();
  }

  function togglePanel() { panelOpen ? closePanel() : openPanel(); }

  function openPanel() {
    panelOpen = true;
    document.getElementById('promptq-panel')?.classList.add('open');
    const chev = document.getElementById('pq-strip-chevron');
    if (chev) chev.classList.add('open');
  }

  function closePanel() {
    panelOpen = false;
    document.getElementById('promptq-panel')?.classList.remove('open');
    const chev = document.getElementById('pq-strip-chevron');
    if (chev) chev.classList.remove('open');
  }

  // ─── UI updates ───────────────────────────────────────────────────────────────
  function updateUI() {
    if (!uiInjected) return;
    updateStrip();
    updatePanel();
  }

  const STATE_CONFIG = {
    IDLE:      { dotClass: 'green', stripText: 'Ready',                   panelText: 'Ready' },
    STREAMING: { dotClass: 'blue',  stripText: 'Claude is responding...', panelText: 'Claude is responding...' },
    LIMITED:   { dotClass: 'red',   stripText: 'Limit active',            panelText: 'Limit active — queue your prompts' },
    FIRING:    { dotClass: 'blue',  stripText: 'Firing queue...',         panelText: 'Firing queued prompts...' },
  };

  function updateStrip() {
    const cfg     = STATE_CONFIG[machineState] || STATE_CONFIG.IDLE;
    const dot     = document.getElementById('pq-strip-dot');
    const status  = document.getElementById('pq-strip-status');
    const count   = document.getElementById('pq-strip-count');
    if (!dot) return;

    dot.className = cfg.dotClass;
    status.textContent = machineState === 'LIMITED' && state.resetAt
      ? `Limit active — resets in ${formatMs(state.resetAt - Date.now())}`
      : cfg.stripText;

    const pending = state.queue.filter(q => q.status === 'pending').length;
    count.textContent = pending;
    count.classList.toggle('hidden', pending === 0);
  }

  function updatePanel() {
    const cfg        = STATE_CONFIG[machineState] || STATE_CONFIG.IDLE;
    const dot        = document.getElementById('pq-dot');
    const statusText = document.getElementById('pq-status-text');
    const meterRow   = document.getElementById('pq-meter-row');
    if (!dot) return;

    dot.className = `pq-dot pq-dot-${cfg.dotClass}`;
    statusText.textContent = cfg.panelText;

    if (meterRow) {
      const parts = [];
      if (state.sessionReset && state.sessionReset > Date.now())
        parts.push(`Session resets in ${formatMs(state.sessionReset - Date.now())}`);
      if (state.weeklyReset && state.weeklyReset > Date.now())
        parts.push(`Weekly resets in ${formatMs(state.weeklyReset - Date.now())}`);
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
      updateStrip(); // keep strip in sync too
    }, 1000);
  }

  // ─── Queue list ───────────────────────────────────────────────────────────────
  function addPrompt() {
    const input = document.getElementById('pq-input');
    const text  = (input?.value || '').trim();
    if (!text) return;
    state.queue.push({ id: Date.now(), text, status: 'pending' });
    input.value = '';
    saveState();
    renderQueueList();
    if (!panelOpen) openPanel();
  }

  function renderQueueList() {
    const list    = document.getElementById('pq-queue-list');
    const empty   = document.getElementById('pq-empty');
    const count   = document.getElementById('pq-queue-count');
    const fireBtn = document.getElementById('pq-fire-btn');
    if (!list) return;

    const pending = state.queue.filter(q => q.status === 'pending');
    if (count)   count.textContent = `${pending.length} queued`;
    if (fireBtn) fireBtn.disabled  = pending.length === 0 || machineState === 'FIRING';
    if (empty)   empty.style.display = state.queue.length === 0 ? '' : 'none';

    list.innerHTML = state.queue.map((item, i) => `
      <div class="pq-item pq-status-${item.status}">
        <div class="pq-item-pos">${item.status === 'sending' ? '▶' : i + 1}</div>
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

    updateStrip();
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────
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

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ─── Background messages ──────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'LIMIT_RESET') { state.limited = false; tick(); }
    if (msg.type === 'OPEN_PANEL')  { openPanel(); }
  });

  // ─── Observer ────────────────────────────────────────────────────────────────
  function startObserver() {
    if (observerStarted) return;
    observerStarted = true;
    new MutationObserver(() => {
      if (!uiInjected) injectUI();
      tick();
    }).observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['aria-label', 'disabled', 'data-is-streaming'],
    });
    setInterval(tick, 5000);
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────
  async function init() {
    await loadState();
    startObserver();
    tick();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
