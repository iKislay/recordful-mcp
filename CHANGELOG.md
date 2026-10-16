# Changelog

## 0.1.0 (2026-10-17)

First release: Phase 0 of letting AI agents drive the Recordful recorder.

- MCP server on stdio (`recordful-mcp`), built on the official SDK, with tools `get_status`, `start_recording`, `pause_recording`, `resume_recording`, `stop_recording` and `probe_capture`, plus agent instructions for the record-a-feature workflow.
- Loopback WebSocket bridge to the Recordful extension: mutual HMAC-SHA256 challenge-response over a per-user pairing token, Origin and extension-ID allowlist, a single superseding session, heartbeat, request timeouts and port supervision.
- CLI: `serve` (the default), `token [--rotate]`, `call <method> [json]`.
- Verified in Chrome: after one click on the Recordful icon, the agent started, paused, resumed and stopped recordings, and the web editor opened on stop. Chrome requires that click before tab capture; see `docs/phase-0-findings.md`.
- 34 unit and integration tests, CI on Linux, macOS and Windows (Node 20 and 22), and a live end-to-end script (`scripts/live-spike.mjs`).
