# Changelog

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
