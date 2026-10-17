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
| `page.navigate` | `url` (http/https), `timeoutMs?` (1000–60000, default 20000) | `{url, title, loaded, waitedMs, hint?}` |
| `page.snapshot` | `scope?` (`"page"` default, or `"viewport"`) | `{tabId, url, title, viewport, scroll, boxFormat, focused, elements:[{ref, role, name, value?, checked?, disabled?, expanded?, selected?, pressed?, level?, href?, box:[x,y,w,h], offscreen?}], truncated?, note?}` |
| `page.click` | `ref` | `{clicked:{ref, role, name}, at:{x, y}, note?, navigation?}` |
| `page.type` | `ref`, `text` (≤ 2000), `clear?`, `delayMs?` (0–300, default 70) | `{typed:{ref, role, name}, value}` |
| `page.press` | `key` (`"Enter"`, `"Shift+Tab"`, `"Control+a"`, …) | `{pressed, target, effect, navigation?}` |
| `page.scroll` | `ref`, or `direction` (`up`/`down`/`left`/`right`) with `amount?` px | `{scrolledTo, box}` or `{scrolled, position, container, atEnd}` |
| `page.waitFor` | `text` or `ref`, `state?` (`visible`/`hidden`), `timeoutMs?` (100–60000, default 10000) | `{satisfied:true, waitedMs}` or error `WAIT_TIMEOUT` |
| `page.screenshot` | — | `{mimeType:"image/jpeg", data (base64), width, height, scale, tabId, url, title}` |

Requests run on queues in the extension: recorder methods (`recording.*`, `capture.probe`) one at a time on one queue, page methods one at a time on another, and `status.get` on none, so it never waits behind either.

### Page methods

- **Target tab.** The tab being recorded (`recordingUiTabId`) while a recording runs, otherwise the *armed* tab: the one where the user last clicked the Recordful icon or pressed a Recordful shortcut (`chrome.storage.session.agentBridgeArmedTab`). Never any other tab, whichever is in front. No armed tab → `NOT_ARMED`. `status.get` reports it as `agent.armedTab`.
- **Refs.** `page.snapshot` gives each element a ref (`e1`, `e2`, …) that stays the same for that element while it is on the page. Refs belong to one document: after a navigation or reload, any ref → `STALE_REF` until the agent takes a new snapshot.
- **Execution.** The worker sends `{type:"recordful-agent-page", action, params, cursor, expectDocId}` to the content script (`chrome.tabs.sendMessage`), which acts with synthetic DOM events and answers `{ok, result | error, docId, cursor}`. It draws its own cursor (a fixed, closed-shadow overlay, `pointer-events:none`), glides it to each target, shows a ripple on click and types with jittered per-key delays. Recordful's own UI is excluded from snapshots and hit tests.
- **Limits of synthetic input.** Pages see `isTrusted:false` events. Links, buttons, checkboxes, labels and form submits work; native `<select>` popups, file pickers and anything that requires a real user gesture (pop-ups, clipboard, fullscreen) do not. `page.type` on a `<select>` chooses the matching option instead. `page.press` performs the key's default effect itself (Enter submits or activates, Tab moves focus, Backspace deletes, Space toggles, PageDown scrolls). Iframes are not covered.
- `page.click` and `page.press` report a navigation they started (`navigation:{url, title, loaded | sameDocument}`), and wait up to 10 s for it to load. `page.waitFor` polls from the worker, so it survives navigations.
- `page.screenshot` needs the target tab to be the active tab of a visible window (`TAB_NOT_ACTIVE` otherwise). It is downscaled to at most 1280 px wide and re-encoded until it fits under the 1 MiB frame cap.

## Error codes

`NOT_CONNECTED`, `DISCONNECTED`, `TIMEOUT`, `BRIDGE_UNAVAILABLE`, `INVALID_PARAMS` (bridge side); `UNKNOWN_METHOD`, `ALREADY_RECORDING`, `NOT_RECORDING`, `NO_TARGET_TAB`, `TAB_NOT_RECORDABLE`, `START_FAILED`, `STOP_FAILED`, `INTERNAL`, and for page methods `NOT_ARMED`, `TAB_NOT_ACTIVE`, `PAGE_NOT_SCRIPTABLE`, `STALE_REF`, `ELEMENT_NOT_INTERACTABLE`, `ELEMENT_OBSCURED` (with `data.obscuredBy`), `NAVIGATION_FAILED`, `WAIT_TIMEOUT` (extension side). Codes are a public contract: new codes can be added, but existing ones are never repurposed.

## Extension adapter

`recordful/src/pages/Background/agentBridge/`:

| File | Role |
| --- | --- |
| `index.js` | Reads build-time config and starts the client |
| `client.js` | Connection on demand, handshake, ping, request dispatch, serialization. It connects on a toolbar-icon click or shortcut (one attempt), after a dropped session (6 retries with jitter, 1 s → 30 s, about 80 s total), and on worker boot if a session was live (`chrome.storage.session.agentBridgeWanted`). It never polls, because Chrome logs every refused WebSocket on `chrome://extensions` |
| `auth.js` | WebCrypto HMAC and nonces, mirroring `src/auth/handshake.ts` |
| `commands.js` | Recorder method implementations. Each one sends the same message as the matching keyboard shortcut (`start-stream`, `stop-recording-tab`, `pause-recording`) |
| `pageCommands.js` | Page method implementations: picks the target tab, navigation, waits, screenshots, and relays the rest to the content script |
| `armedTab.js` | Remembers the tab the user handed over (icon click or shortcut) |
| `../../Content/agentPage/` | Content-script side: snapshot and refs, the rendered cursor, click/type/press/scroll |
| `errors.js` | Error codes |

Build gating, in `recordful/webpack.config.js` and `src/pages/Background/index.js`:

- `RECORDFUL_AGENT_BRIDGE=1` is required, and webpack throws if it's set on a non-development build. `npm run build:agent` sets it.
- In every other build, DefinePlugin folds the guard to `false`, so webpack never parses the import. A production build contains no adapter code, which was checked by grepping the bundle, and `scripts/assert-no-dev-env.mjs` would also flag the `127.0.0.1` URL.
- The content-script half (`Content/agentPage/`) is gated the same way in `src/pages/Content/index.jsx`. A release build (`npm run build:release`) was grepped for every adapter and page-tool identifier, source maps included: none present.
- The token comes from `chrome.storage.local.agentBridgeToken` if set, otherwise from `RECORDFUL_AGENT_BRIDGE_TOKEN` baked in at build time. Likewise `chrome.storage.local.agentBridgePort` overrides the build-time port; changing either makes the extension reconnect.
