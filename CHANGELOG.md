# Changelog

## 0.3.0 (2026-10-17)

Ready for everyone: install with one line in any AI app, pair with one click, no tokens or builds.

- **Pairing replaces tokens.** The first time an AI app connects, Recordful opens a window naming the app with a 4-digit code; the agent gets `PAIRING_PENDING` with the same code to show in chat. On Allow, both sides keep a fresh per-pairing secret. Pairing happens once per computer, shared by every AI app (protocol v2, new path `/recordful-agent-bridge/v2`).
- **Ships in Recordful itself**, off until the user turns on AI agents (Recordful popup → More → AI agents). That page has the switch, connection status, the setup command and paired apps with Forget. The toolbar icon shows an "AI" badge while an app is connected.
- **Only the official extension by default.** The Chrome Web Store build is allowed out of the box; `RECORDFUL_BRIDGE_ALLOWED_EXTENSION_IDS` adds development builds (`*` allows any).
- **`record_feature` prompt**: the whole plan-and-record workflow, available in every MCP client that supports prompts.
- **Fail-fast starts**: in tab capture modes, `start_recording` on a tab the user hasn't handed over returns `NOT_ARMED` at once instead of stalling, and targets the handed-over tab by default. A healthy start is no longer misreported as `START_FAILED` when it takes ~5 s.
- **One-step installs**: Claude Code plugin (MCP server, `record-demo` skill, `/record-demo` command) via `/plugin marketplace add iKislay/recordful-mcp`; Claude Desktop extension (`recordful.mcpb`, `npm run pack:mcpb`); MCP Registry entry (`server.json`).
- CLI: `setup` prints the configuration for each AI app, `status` shows the pairing state, `unpair` forgets pairings. `token` is gone.
- Agent instructions and errors cover first-run setup (`NOT_CONNECTED`, `PAIRING_PENDING`, `PAIRING_DENIED`, `NOT_ARMED`).
- Live test `scripts/live-pairing.mjs`: switch on, pairing window, code match, Allow, reconnect without prompting, fail-fast start, Deny, switch off. All 15 checks pass in Edge 155.
- Needs Recordful with the AI agents page (iKislay/recordful after 4.6.15).

## 0.2.0 (2026-10-17)

Phase 1: page tools, so an agent with no browser tool of its own can record a feature end to end.

- MCP tools `navigate`, `snapshot`, `click`, `type`, `press`, `scroll`, `wait_for` and `screenshot` (image content), over new protocol methods `page.*`. Inputs are validated with zod before they reach the extension, and the `call` CLI validates page methods the same way. Protocol version unchanged (methods were added, nothing changed shape).
- They act only on the tab the user handed over by clicking the Recordful icon, or the tab being recorded. The extension draws its own cursor, glides it to each target, highlights clicks and types at a human pace.
- New error codes: `NOT_ARMED`, `TAB_NOT_ACTIVE`, `PAGE_NOT_SCRIPTABLE`, `STALE_REF`, `ELEMENT_NOT_INTERACTABLE`, `ELEMENT_OBSCURED`, `NAVIGATION_FAILED`, `WAIT_TIMEOUT`. An extension build without page tools gets a hint to rebuild.
- Agent instructions now cover the whole flow: plan, ask for the click on the Recordful icon, navigate, start, act with page tools, pause while thinking, stop.
- `scripts/live-spike.mjs --pages` exercises every page tool live; `--port` runs alongside an MCP client's bridge.
- Verified live in Edge 155: every page tool, tab targeting, stale refs and navigations, including during a live tab recording. See `docs/phase-1-findings.md`.
- Needs a Recordful development build (`npm run build:agent`) that includes the page tools: iKislay/recordful after 4.6.15.

## 0.1.0 (2026-10-17)

First release: Phase 0 of letting AI agents drive the Recordful recorder.

- MCP server on stdio (`recordful-mcp`), built on the official SDK, with tools `get_status`, `start_recording`, `pause_recording`, `resume_recording`, `stop_recording` and `probe_capture`, plus agent instructions for the record-a-feature workflow.
- Loopback WebSocket bridge to the Recordful extension: mutual HMAC-SHA256 challenge-response over a per-user pairing token, Origin and extension-ID allowlist, a single superseding session, heartbeat, request timeouts and port supervision.
- CLI: `serve` (the default), `token [--rotate]`, `call <method> [json]`.
- Verified in Chrome: after one click on the Recordful icon, the agent started, paused, resumed and stopped recordings, and the web editor opened on stop. Chrome requires that click before tab capture; see `docs/phase-0-findings.md`.
- 34 unit and integration tests, CI on Linux, macOS and Windows (Node 20 and 22), and a live end-to-end script (`scripts/live-spike.mjs`).
