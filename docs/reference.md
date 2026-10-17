# Reference

## Tools

| Tool | What it does |
| --- | --- |
| `get_status` | Connection, pairing, recorder state (`idle`, `starting`, `recording`, `paused`), recording mode, the tab handed over |
| `start_recording` | Starts recording the handed-over tab with your Recordful settings (mode, microphone, camera, countdown); returns once capture is live |
| `pause_recording` / `resume_recording` | Pause and resume, so thinking time stays out of the video |
| `stop_recording` | Stops; Recordful opens its editor and the tool returns the editor tab |
| `navigate` | Opens an http(s) URL in the handed-over tab and waits for it to load |
| `snapshot` | Lists interactive elements and headings, each with a ref (`e12`), role, name, value or state, and position |
| `click` | Glides Recordful's cursor to the element and clicks it, with a click highlight in the video |
| `type` | Types into a field at a human pace (or picks an option in a dropdown) |
| `press` | Presses a key (Enter, Tab, Escape, arrows, `Shift+Tab`, `Control+a`…) and performs its usual effect |
| `scroll` | Scrolls smoothly to an element, or by an amount in a direction |
| `wait_for` | Waits for text or an element to appear or go away; keeps waiting across page loads |
| `screenshot` | Returns what the tab shows right now, as an image |
| `probe_capture` | Diagnostic: whether Recordful can capture the tab right now, and which permissions are granted |

Page tools use synthetic browser events. Links, buttons, checkboxes, form fields and form submits work. Native dropdown popups, file pickers, content inside iframes, and actions that need a real user gesture (opening pop-up windows, the clipboard) don't. Details: [protocol.md](protocol.md#page-methods).

## Prompt

`record_feature(feature, url?)`: the full plan-and-record workflow. In Claude Code it's `/mcp__recordful__record_feature`, or `/record-demo` with the plugin.

## Command line

```text
npx -y recordful-mcp                      run the MCP server (what AI apps start)
npx -y recordful-mcp setup                print the setup snippet for each AI app
npx -y recordful-mcp status               show this computer's pairing state
npx -y recordful-mcp unpair <id>|--all    forget a paired Recordful (or all)
npx -y recordful-mcp call <method> [json] call one Recordful method directly, for debugging
```

## Configuration

All optional, set through environment variables (for example in your AI app's `env` block for the server).

| Variable | Default | Purpose |
| --- | --- | --- |
| `RECORDFUL_BRIDGE_PORT` | `47823` | Local port. The Chrome Web Store build of Recordful always uses 47823 |
| `RECORDFUL_BRIDGE_ALLOWED_EXTENSION_IDS` | — | Extra extension IDs allowed to connect, comma-separated (e.g. an unpacked development build). The store build is always allowed; `*` allows any (development only) |
| `RECORDFUL_BRIDGE_STATE_PATH` | `~/.recordful/agent-bridge.json` | Where the pairing is kept |
| `RECORDFUL_BRIDGE_TOKEN` | — | Shared secret instead of pairing, for CI and scripted runs against development builds |
| `RECORDFUL_BRIDGE_REQUEST_TIMEOUT_MS` | `15000` | Base timeout per request (recording calls add their own wait) |
| `RECORDFUL_BRIDGE_CONNECT_WAIT_MS` | `8000` | How long a tool waits for Recordful to connect |
| `RECORDFUL_BRIDGE_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. Logs are JSON lines on stderr |

Only one server can own the port at a time. If two AI apps each start one, the second retries in the background and takes over when the first exits; until then its tools report `BRIDGE_UNAVAILABLE`.
