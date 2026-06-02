/*
  promptq interceptor — runs in PAGE context (not content-script isolated world)
  so it can hook window.fetch BEFORE claude.ai's own code uses it.

  Reads two sources of truth, exactly like Claude Counter does:
    1. /api/organizations/{orgId}/usage  — full session + weekly limits
    2. SSE  message_limit  events  — live, exact resetsAt timestamps

  Posts the parsed data to the content script via window.postMessage.
  No DOM scraping. No external requests. Reads only claude.ai's own traffic.
*/
(() => {
  'use strict';
  if (window.__promptqInterceptorInstalled) return;
  window.__promptqInterceptorInstalled = true;

  const POST = (type, payload) => {
    window.postMessage({ source: 'promptq-interceptor', type, payload }, '*');
  };

  // ─── Parse a /usage API response into session + weekly limits ──────────────
  function parseUsageResponse(data) {
    try {
      // The /usage endpoint returns objects describing each limit window.
      // Shapes vary slightly by account type; handle the common keys.
      const out = {};

      // Newer shape: { five_hour: {...}, seven_day: {...} } or similar
      // We look for any object with a resets_at / resetsAt and utilization
      const scan = (obj, label) => {
        if (!obj || typeof obj !== 'object') return;
        const resetsAt = obj.resets_at || obj.resetsAt || obj.reset_at || obj.resetAt;
        const util = obj.utilization ?? obj.used_fraction ?? obj.fraction ?? obj.percentage;
        if (resetsAt) {
          out[label] = {
            resetsAt: typeof resetsAt === 'number' ? resetsAt : Date.parse(resetsAt),
            utilization: typeof util === 'number' ? util : null,
          };
        }
      };

      // Try known key names for session (5-hour) and weekly (7-day)
      scan(data.five_hour || data.fiveHour || data.session || data.five_hour_limit, 'session');
      scan(data.seven_day || data.sevenDay || data.weekly || data.seven_day_limit, 'weekly');

      // Fallback: if there's an array of limits, classify by window length
      if (Array.isArray(data.limits)) {
        for (const lim of data.limits) {
          const resetsAt = lim.resets_at || lim.resetsAt;
          if (!resetsAt) continue;
          const ms = (typeof resetsAt === 'number' ? resetsAt : Date.parse(resetsAt)) - Date.now();
          const label = ms < 6 * 3600 * 1000 ? 'session' : 'weekly';
          out[label] = {
            resetsAt: typeof resetsAt === 'number' ? resetsAt : Date.parse(resetsAt),
            utilization: lim.utilization ?? null,
          };
        }
      }

      if (out.session || out.weekly) POST('USAGE', out);
    } catch (e) {
      // swallow — never break the page
    }
  }

  // ─── Parse an SSE message_limit event ──────────────────────────────────────
  function parseSSELine(line) {
    try {
      if (!line.includes('message_limit')) return;
      // SSE data lines look like: data: {"type":"message_limit", ...}
      const jsonStart = line.indexOf('{');
      if (jsonStart === -1) return;
      const obj = JSON.parse(line.slice(jsonStart));
      if (obj.type !== 'message_limit' && !obj.message_limit) return;

      const ml = obj.message_limit || obj;
      const resetsAt = ml.resetsAt || ml.resets_at;
      POST('MESSAGE_LIMIT', {
        type: ml.type,                    // e.g. "within_limit" | "approaching_limit" | "exceeded_limit"
        resetsAt: resetsAt ? (typeof resetsAt === 'number' ? resetsAt : Date.parse(resetsAt)) : null,
        remaining: ml.remaining ?? null,
        perModelLimits: ml.per_model_limits ?? null,
      });
    } catch (e) { /* swallow */ }
  }

  // ─── Hook fetch ─────────────────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = (args[0] && args[0].url) || args[0] || '';
    const response = await origFetch.apply(this, args);

    try {
      const urlStr = String(url);

      // /usage endpoint — clone and parse JSON
      if (urlStr.includes('/usage')) {
        response.clone().json().then(parseUsageResponse).catch(() => {});
      }

      // SSE streams (completion endpoints) — tee the stream and scan for message_limit
      const ct = response.headers.get('content-type') || '';
      if (ct.includes('text/event-stream') && response.body) {
        const [a, b] = response.body.tee();
        // Replace the response body the page sees with stream `a`
        const reader = b.getReader();
        const decoder = new TextDecoder();
        (async () => {
          let buf = '';
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              let nl;
              while ((nl = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                if (line.startsWith('data:')) parseSSELine(line);
              }
            }
          } catch (e) { /* swallow */ }
        })();
        // Return a new Response backed by stream `a` so the page is unaffected
        return new Response(a, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
    } catch (e) { /* never break the page */ }

    return response;
  };

  POST('INTERCEPTOR_READY', {});
})();
