'use strict';

const STATE_KEY = 'promptq_state';
let state = null;
let countdownInterval = null;

async function loadState() {
  return new Promise(resolve => {
    chrome.storage.local.get(STATE_KEY, result => {
      state = result[STATE_KEY] || {
        queue: [],
        resetAt: null,
        limited: false,
        autoFire: true,
        waitForResponse: true,
      };
      resolve();
    });
  });
}

async function saveState() {
  return new Promise(resolve => {
    chrome.storage.local.set({ [STATE_KEY]: state }, resolve);
  });
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function render() {
  if (!state) return;

  // Status badge
  const badge = document.getElementById('status-badge');
  if (state.limited) {
    badge.textContent = 'Limited';
    badge.className = 'badge limited';
  } else {
    badge.textContent = 'Active';
    badge.className = 'badge clear';
  }

  // Status dot + text
  const dot = document.getElementById('dot');
  const statusText = document.getElementById('status-text');
  if (state.limited) {
    dot.className = 'dot red';
    statusText.textContent = 'Rate limit active';
  } else {
    dot.className = 'dot green';
    statusText.textContent = 'Limit clear — ready';
  }

  // Countdown
  startCountdown();

  // Queue list
  const list = document.getElementById('queue-list');
  const empty = document.getElementById('empty-state');
  const count = document.getElementById('q-count');
  const pending = state.queue ? state.queue.filter(q => q.status === 'pending') : [];
  count.textContent = pending.length;

  if (!state.queue || state.queue.length === 0) {
    list.innerHTML = '';
    empty.style.display = '';
  } else {
    empty.style.display = 'none';
    list.innerHTML = state.queue.map((item, i) => `
      <div class="q-item ${item.status !== 'pending' ? item.status : ''}">
        <div class="q-item-num">${i + 1}</div>
        <div class="q-item-text">${escapeHtml(item.text.slice(0, 80))}${item.text.length > 80 ? '…' : ''}</div>
      </div>
    `).join('');
  }

  // Settings
  document.getElementById('autofire').checked = !!state.autoFire;
  document.getElementById('wait-response').checked = !!state.waitForResponse;
}

function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  const el = document.getElementById('countdown');
  if (!state.limited || !state.resetAt) { el.textContent = ''; return; }

  function tick() {
    const ms = state.resetAt - Date.now();
    if (ms <= 0) { el.textContent = 'resetting...'; return; }
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    el.textContent = h > 0 ? `${h}h ${m}m` : `${m}:${String(s).padStart(2,'0')}`;
  }
  tick();
  countdownInterval = setInterval(tick, 1000);
}

async function init() {
  await loadState();
  render();

  // Set extension version
  const manifest = chrome.runtime.getManifest();
  document.getElementById('version').textContent = `v${manifest.version}`;

  // Open claude.ai
  document.getElementById('open-btn').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://claude.ai' });
    window.close();
  });

  // Clear queue
  document.getElementById('clear-btn').addEventListener('click', async () => {
    state.queue = [];
    await saveState();
    render();
    // Tell content script too
    const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'SYNC_STATE', state }).catch(() => {});
    }
  });

  // Settings toggles
  document.getElementById('autofire').addEventListener('change', async e => {
    state.autoFire = e.target.checked;
    await saveState();
  });
  document.getElementById('wait-response').addEventListener('change', async e => {
    state.waitForResponse = e.target.checked;
    await saveState();
  });

  // Listen for storage changes to re-render live
  chrome.storage.onChanged.addListener((changes) => {
    if (changes[STATE_KEY]) {
      state = changes[STATE_KEY].newValue;
      render();
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
