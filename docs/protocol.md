# Bridge protocol (v1)

The transport between `recordful-mcp` (server) and the Recordful extension's service worker (client). The source of truth is `src/protocol/messages.ts`; the extension keeps a hand-written mirror in `recordful/src/pages/Background/agentBridge/`. Any breaking change bumps `PROTOCOL_VERSION` on both sides.

## Transport

- WebSocket at `ws://127.0.0.1:<port>/recordful-agent-bridge/v1` (default port `47823`).
- JSON text frames only, each at most 1 MiB.
- The server rejects the HTTP upgrade (403) unless `Origin` is `chrome-extension://<32 a–p chars>` and, when an allowlist is configured, that ID is on it.

## Handshake

```
server → client  {type:"challenge", protocolVersion:1, serverNonce}
client → server  {type:"hello", protocolVersion:1, clientNonce, proof, client:{extensionId, extensionVersion, browser}}
server → client  {type:"welcome", sessionId, proof}
```

- Nonces are 32 random bytes, hex-encoded.
- `proof = hex(HMAC-SHA256(token, "recordful-agent-bridge:<role>:<serverNonce>:<clientNonce>"))`, where role is `client` for the hello proof and `server` for the welcome proof.
- The server checks that `client.extensionId` matches the Origin, then checks the client proof in constant time.
- The client checks the server proof and **refuses to process any request** until it passes. The token itself is never sent in either direction.
- Handshake deadline: 5 s.

## Steady state

| Direction | Message |
| --- | --- |
| server → client | `{type:"request", id, method, params}` |
| client → server | `{type:"response", id, ok:true, result}` or `{type:"response", id, ok:false, error:{code, message, data?}}` |
| client → server | `{type:"event", name, data?}` (reserved for Phase 1 state push) |
| client → server | `{type:"ping", ts}` every 20 s; the server answers `{type:"pong", ts}` |

The 20 s ping also keeps the MV3 service worker alive (Chrome 116+ extends worker lifetime while a WebSocket is active). The server drops a session that has been silent for 65 s.

One authenticated session at a time: a newer authenticated connection supersedes the old one (close `4409`).

## Close codes

| Code | Meaning |
| --- | --- |
| 4400 | Malformed or unexpected message |
| 4401 | Authentication failed (deliberately not more specific) |
| 4408 | Handshake timeout |
| 4409 | Superseded by a newer session |
| 4410 | Heartbeat timeout |
| 4426 | Protocol version mismatch (the client backs off to its longest retry delay) |

## Methods

| Method | Params | Result |
| --- | --- | --- |
| `status.get` | — | `{state, recordingType, recordingUiTabId, recordingStartTime, activeTab, permissions, extension, editor}` |
| `recording.start` | `tabId?`, `timeoutMs?` (1000–120000, default 30000) | `{outcome:"recording", tabId, recordingType, waitedMs, recordingStartTime}` or `{outcome:"pending", hint, ...}` |
| `recording.stop` | `timeoutMs?` | `{outcome:"stopped", editorTabId, editorUrl, hint?}` |
| `recording.pause` / `recording.resume` | — | `{outcome:"paused"/"recording", changed}` |
| `capture.probe` | `tabId?` | `{tab, recordable, tabCapture:{ok, error}, permissions, recordingType}` |

Mutating methods (`recording.*`, `capture.probe`) are serialized in the extension; `status.get` is never queued behind them.

## Error codes

`NOT_CONNECTED`, `DISCONNECTED`, `TIMEOUT`, `BRIDGE_UNAVAILABLE`, `INVALID_PARAMS` (bridge side); `UNKNOWN_METHOD`, `ALREADY_RECORDING`, `NOT_RECORDING`, `NO_TARGET_TAB`, `TAB_NOT_RECORDABLE`, `START_FAILED`, `STOP_FAILED`, `INTERNAL` (extension side). Codes are a public contract: new codes can be added, but existing ones are never repurposed.

## Extension adapter

`recordful/src/pages/Background/agentBridge/`:

| File | Role |
| --- | --- |
| `index.js` | Reads build-time config and starts the client |
| `client.js` | Connection on demand, handshake, ping, request dispatch, serialization. It connects on a toolbar-icon click or shortcut (one attempt), after a dropped session (6 retries with jitter, 1 s → 30 s, about 80 s total), and on worker boot if a session was live (`chrome.storage.session.agentBridgeWanted`). It never polls, because Chrome logs every refused WebSocket on `chrome://extensions` |
| `auth.js` | WebCrypto HMAC and nonces, mirroring `src/auth/handshake.ts` |
| `commands.js` | Method implementations. Each one sends the same message as the matching keyboard shortcut (`start-stream`, `stop-recording-tab`, `pause-recording`) |
| `errors.js` | Error codes |

Build gating, in `recordful/webpack.config.js` and `src/pages/Background/index.js`:

- `RECORDFUL_AGENT_BRIDGE=1` is required, and webpack throws if it's set on a non-development build. `npm run build:agent` sets it.
- In every other build, DefinePlugin folds the guard to `false`, so webpack never parses the import. A production build contains no adapter code, which was checked by grepping the bundle, and `scripts/assert-no-dev-env.mjs` would also flag the `127.0.0.1` URL.
- The token comes from `chrome.storage.local.agentBridgeToken` if set, otherwise from `RECORDFUL_AGENT_BRIDGE_TOKEN` baked in at build time.
