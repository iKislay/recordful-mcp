# Recordful Agent Bridge

An [MCP](https://modelcontextprotocol.io) server that lets AI agents (Claude Code, Claude Desktop, Cursor, any MCP client) drive the [Recordful](https://recordful.app) browser extension's recorder: start, pause, resume and stop recordings, with Recordful's editor opening automatically afterwards.

> **Status: Phase 0 spike, verified.** In the user's Chrome, the agent started, paused, resumed and stopped recordings through the bridge, and the editor opened automatically. Chrome needs one human click on the Recordful icon per tab before capture can start; see [docs/phase-0-findings.md](docs/phase-0-findings.md).

## How it works

```
MCP client (Claude, Cursor, ...)
   │  stdio (MCP)
   ▼
recordful-mcp  ── WebSocket on 127.0.0.1:47823, mutual HMAC handshake ──►  Recordful extension
 (this repo)                                                               (service worker adapter)
                                                                                │
                                                                                ▼
                                                     the same messages the keyboard shortcuts send
                                                     → recorder → editor opens on stop
```

- The agent does the "what to record" part with whatever browser tool it already has (Claude in Chrome, Playwright MCP, computer use). This server only provides the recorder controls.
- The extension dials **out** to the bridge, because an MV3 service worker can't listen on a socket. The bridge binds to loopback only.
- Agent-triggered actions go through the same code paths as Recordful's keyboard shortcuts, so the user's saved settings and every built-in check still apply.

## Tools

| Tool | What it does |
| --- | --- |
| `get_status` | Bridge connection plus recorder state (`idle`, `starting`, `recording`, `paused`), mode, active tab, granted permissions |
| `start_recording` | Starts recording on the active (or given) tab with the user's Recordful settings, and waits until capture is live |
| `pause_recording` / `resume_recording` | Pauses and resumes recording, so the agent's thinking time doesn't end up in the video |
| `stop_recording` | Stops the recording; Recordful opens its editor and the tool returns the editor tab |
| `probe_capture` | Diagnostic: can the extension capture this tab right now without a click? |

The server also sends MCP `instructions` that teach the agent the record-a-feature workflow.

## Quick start (development)

Prerequisites: Node 20.10+, and the `recordful` repo next to this one.

```bash
# 1. Build the bridge and create the pairing token (~/.recordful/agent-bridge.json)
npm install
npm run build
node dist/cli.js token

# 2. Build Recordful with the bridge compiled in (development builds only)
cd ../recordful
RECORDFUL_AGENT_BRIDGE_TOKEN=<token from step 1> npm run build:agent
#   recordings open in the web editor at recordful.app, or at RECORDFUL_APP_BASE
#   (e.g. http://localhost:3000 with recordful-ee running locally)

# 3. Load recordful/build as an unpacked extension (chrome://extensions → Developer mode → Load unpacked)
```

Then register the server with your MCP client.

**The extension connects on demand.** It dials the bridge when you click the Recordful toolbar icon or press its shortcut, which is the same gesture Chrome needs before tab capture. Once connected, it stays connected; if the bridge restarts, the extension retries for about a minute. It never polls in the background, so a build with the bridge doesn't fill `chrome://extensions` with connection errors when no agent is running. Agents are told to ask you for that click when a tool reports `NOT_CONNECTED`.

**Claude Code**

```bash
claude mcp add recordful -- node /absolute/path/to/recordful-agent-bridge/dist/cli.js
```

**Claude Desktop / Cursor** (`mcpServers` in their config file)

```json
{
  "mcpServers": {
    "recordful": {
      "command": "node",
      "args": ["/absolute/path/to/recordful-agent-bridge/dist/cli.js"],
      "env": {
        "RECORDFUL_BRIDGE_ALLOWED_EXTENSION_IDS": "<your unpacked extension id>"
      }
    }
  }
}
```

**opencode** (`opencode.json`)

```json
{
  "mcp": {
    "recordful": {
      "type": "local",
      "command": ["node", "/absolute/path/to/recordful-agent-bridge/dist/cli.js"],
      "enabled": true
    }
  }
}
```

Any other client that launches local stdio MCP servers works the same way. Agents without a browser tool can control the recorder today. Clicking through the feature by themselves needs the Phase 1 page tools; see [docs/roadmap.md](docs/roadmap.md). Cloud-only apps (claude.ai or ChatGPT connectors in the browser) need the hosted server; see [docs/remote-mcp.md](docs/remote-mcp.md).

Test it without an MCP client:

```bash
node dist/cli.js call status.get
node dist/cli.js call capture.probe
```

You can also set the token at runtime instead of baking it into the build. Run this in the extension service worker's DevTools console:
`chrome.storage.local.set({ agentBridgeToken: "<token>" })`.

## Configuration

All configuration is through environment variables, so it can sit in an MCP client's `env` block.

| Variable | Default | Purpose |
| --- | --- | --- |
| `RECORDFUL_BRIDGE_PORT` | `47823` | Loopback port. Must match the extension's `RECORDFUL_AGENT_BRIDGE_PORT` |
| `RECORDFUL_BRIDGE_TOKEN` | — | Pairing token; overrides the token file |
| `RECORDFUL_BRIDGE_TOKEN_PATH` | `~/.recordful/agent-bridge.json` | Token file location |
| `RECORDFUL_BRIDGE_ALLOWED_EXTENSION_IDS` | *(any)* | Comma-separated extension IDs allowed to pair. **Set this** outside throwaway setups |
| `RECORDFUL_BRIDGE_REQUEST_TIMEOUT_MS` | `15000` | Base per-request timeout (recording calls add their own wait) |
| `RECORDFUL_BRIDGE_CONNECT_WAIT_MS` | `8000` | How long a tool waits for a sleeping extension to reconnect |
| `RECORDFUL_BRIDGE_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. Logs are JSON lines on stderr |

Only one process can own the port. If two MCP clients each launch `recordful-mcp`, the second keeps retrying in the background and its tools report `BRIDGE_UNAVAILABLE` until the first exits.

## Development

```bash
npm run check      # typecheck + unit/integration tests
npm run dev        # run the CLI from source (tsx)
node scripts/live-spike.mjs --extension ../recordful/build --out spike-out --channel msedge
```

`scripts/live-spike.mjs` loads the real extension build in a throwaway profile and drives it through the real bridge. Branded Chrome ignores `--load-extension` (v137+), so it uses Playwright's Chromium or Microsoft Edge.

## Repository layout

```
src/
  cli.ts                  entry point: serve (MCP over stdio), token, call
  config.ts               environment → typed config
  logger.ts               JSON-lines stderr logger with redaction
  auth/                   pairing token storage, HMAC challenge-response
  bridge/                 WebSocket server, session/heartbeat/request lifecycle, port supervision
  mcp/                    MCP tool definitions
  protocol/               wire messages (zod), method names, error codes
test/                     vitest: handshake/security, request lifecycle, MCP tools, config/token
scripts/live-spike.mjs    end-to-end check against a real extension build
docs/                     protocol, Phase 0 findings, roadmap, hosted MCP plan
```

The extension side lives in the Recordful repo at `src/pages/Background/agentBridge/` and is compiled in only when `RECORDFUL_AGENT_BRIDGE=1` is set for a development build. See [docs/protocol.md](docs/protocol.md#extension-adapter).
