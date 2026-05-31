'use strict';

const ALARM_NAME = 'promptq_reset';
const STATE_KEY = 'promptq_state';

// ─── Alarm: fires when rate limit should reset ────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  // Notify all claude.ai tabs that the limit has reset
  const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'LIMIT_RESET' }).catch(() => {});
  }

  // Update stored state
  const result = await chrome.storage.local.get(STATE_KEY);
  if (result[STATE_KEY]) {
    result[STATE_KEY].limited = false;
    result[STATE_KEY].resetAt = null;
    await chrome.storage.local.set({ [STATE_KEY]: result[STATE_KEY] });
  }
});

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SET_ALARM') {
    const delayMs = msg.resetAt - Date.now();
    if (delayMs > 0) {
      chrome.alarms.create(ALARM_NAME, { when: msg.resetAt });
      console.log(`[promptq] Alarm set for ${new Date(msg.resetAt).toLocaleTimeString()}`);
    }
    sendResponse({ ok: true });
  }

  if (msg.type === 'NOTIFY') {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: msg.title || 'promptq',
      message: msg.message || 'Queue complete.',
      priority: 1,
    });
    sendResponse({ ok: true });
  }

  if (msg.type === 'CLEAR_ALARM') {
    chrome.alarms.clear(ALARM_NAME);
    sendResponse({ ok: true });
  }

  return true; // keep message channel open for async
});

// ─── Extension icon click: open claude.ai if not already open ────────────────

chrome.action.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
  if (tabs.length > 0) {
    chrome.tabs.update(tabs[0].id, { active: true });
    chrome.windows.update(tabs[0].windowId, { focused: true });
    chrome.tabs.sendMessage(tabs[0].id, { type: 'OPEN_PANEL' }).catch(() => {});
  } else {
    chrome.tabs.create({ url: 'https://claude.ai' });
  }
});
