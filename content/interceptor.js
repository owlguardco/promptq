/*
  promptq interceptor — runs in PAGE context (MAIN world, document_start) so it
  can hook window.fetch BEFORE claude.ai's own code uses it.

  Two sources of truth, matching she-llac/claude-counter's verified shapes:

    1. GET /api/organizations/{orgId}/usage
         { five_hour: { utilization: <0-100>, resets_at: <ISO string> },
           seven_day: { utilization: <0-100>, resets_at: <ISO string> } }

    2. SSE during completions — a line:
         data: {"type":"message_limit","message_limit":{
                  "windows":{ "5h": {"utilization":<0-1>,"resets_at":<unix seconds>},
                              "7d": {"utilization":<0-1>,"resets_at":<unix seconds>} }}}
       NOTE the unit differences vs /usage: utilization is a 0-1 FRACTION here,
       resets_at is UNIX SECONDS here.

  Both are normalized to a common shape before posting to the content script:
    { session: { resetsAt: <ms>, utilization: <0-100> },
      weekly:  { resetsAt: <ms>, utilization: <0-100> } }

  No DOM scraping. No external requests. Reads only claude.ai's own traffic
  plus the lastActiveOrg cookie (for the one proactive /usage fetch on load).
*/
(() => {
  'use strict';
  if (window.__promptqInterceptorInstalled) return;
  window.__promptqInterceptorInstalled = true;

  const POST = (type, payload) =>
    window.postMessage({ source: 'promptq-interceptor', type, payload }, '*');

  // Normalize any reset timestamp to epoch ms.
  // /usage gives an ISO string; SSE gives unix seconds. A unix-seconds value for
  // any near-future date is < 1e12, while epoch-ms is > 1e12 — use that to tell
  // seconds from ms without guessing per-source.
  function toMs(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
    if (typeof v === 'string') {
      const t = Date.parse(v);
      return Number.isFinite(t) ? t : null;
    }
    return null;
  }

  // ─── /usage response → normalized usage ──────────────────────────────────────
  function parseUsageResponse(data) {
    try {
      if (!data || typeof data !== 'object') return;
      const win = (w) => {
        if (!w || typeof w !== 'object') return null;
        const util = typeof w.utilization === 'number' ? w.utilization : null; // already 0-100
        const resetsAt = w.resets_at ? toMs(w.resets_at) : null;
        if (resetsAt == null && util == null) return null;
        return { resetsAt, utilization: util };
      };
      const out = {};
      const s = win(data.five_hour);
      const k = win(data.seven_day);
      if (s) out.session = s;
      if (k) out.weekly = k;
      if (out.session || out.weekly) POST('USAGE', out);
    } catch (e) { /* never break the page */ }
  }

  // ─── SSE message_limit payload → normalized usage ────────────────────────────
  function parseMessageLimit(ml) {
    try {
      if (!ml || typeof ml !== 'object' || !ml.windows) return;
      const win = (w) => {
        if (!w || typeof w !== 'object') return null;
        const util = typeof w.utilization === 'number' ? w.utilization * 100 : null; // 0-1 → 0-100
        const resetsAt = w.resets_at != null ? toMs(w.resets_at) : null;
        if (resetsAt == null && util == null) return null;
        return { resetsAt, utilization: util };
      };
      const out = {};
      const s = win(ml.windows['5h']);
      const k = win(ml.windows['7d']);
      if (s) out.session = s;
      if (k) out.weekly = k;
      if (out.session || out.weekly) POST('MESSAGE_LIMIT', out);
    } catch (e) { /* swallow */ }
  }

  function scanSSELine(line) {
    if (!line.startsWith('data:')) return;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]' || !raw.includes('message_limit')) return;
    try {
      const json = JSON.parse(raw);
      if (json && json.type === 'message_limit' && json.message_limit) {
        parseMessageLimit(json.message_limit);
      }
    } catch (e) { /* not our event */ }
  }

  // Read a cloned SSE stream in the background. We clone (never tee+rebuild) so the
  // page's own response is untouched — this is claude-counter's proven approach.
  async function readEventStream(response) {
    try {
      const reader = response.clone().body?.getReader?.();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split(/\r\n|\r|\n/);
        buf = lines.pop() || '';
        for (const line of lines) scanSSELine(line);
      }
    } catch (e) { /* best-effort */ }
  }

  // ─── Hook fetch ──────────────────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await origFetch.apply(this, args);
    try {
      const a = args[0];
      const url = typeof a === 'string' ? a
        : a instanceof URL ? a.href
        : a instanceof Request ? a.url
        : '';

      if (url.includes('/usage')) {
        response.clone().json().then(parseUsageResponse).catch(() => {});
      }

      const ct = response.headers.get('content-type') || '';
      if (ct.includes('text/event-stream') && response.body) {
        readEventStream(response);
      }
    } catch (e) { /* never break the page */ }
    return response;
  };

  // ─── Proactive: one /usage fetch on load so we have reset times immediately ──
  // claude.ai may not hit /usage until the user acts; pull it once using the org
  // from the lastActiveOrg cookie. Uses the page's credentials, claude.ai-only.
  function getOrgId() {
    try {
      return document.cookie.split('; ')
        .find((r) => r.startsWith('lastActiveOrg='))?.split('=')[1] || null;
    } catch (e) { return null; }
  }
  (function fetchUsageOnce() {
    const orgId = getOrgId();
    if (!orgId) return;
    origFetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
      method: 'GET', credentials: 'include',
    }).then((r) => r.json()).then(parseUsageResponse).catch(() => {});
  })();

  POST('INTERCEPTOR_READY', {});
})();
