# Reference implementation

These files are from [she-llac/claude-counter](https://github.com/she-llac/claude-counter) (MIT licensed),
included here as a reference for the correct way to read claude.ai usage data via API interception
rather than DOM scraping.

- `claude-counter-bridge.js` — the page-context fetch wrapper that intercepts SSE message_limit events and the /usage endpoint
- `claude-counter-main.js` — content-script logic for parsing usage windows into reset timestamps
- `claude-counter-bridge-client.js` — content-script side of the postMessage bridge

We adapt the technique (not copy wholesale) for promptq's needs: we only need the usage/reset
timestamps, not token counting or conversation parsing.

claude-counter is MIT licensed — see THIRD_PARTY_NOTICES if redistributing any adapted code.
