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
| `list_recordings` | Recordings saved on this computer, newest first, with their `takeId` and `videoId` once uploaded |
| `upload_recording` | **Pro.** Uploads a local recording (default: the last one) and waits until it's up; returns the `videoId` and its view and edit links. Never uploads the same recording twice unless `force` |
| `get_video` | A video's title, length, visibility, links and upload stage (`uploading` → `processing` → `ready`); `wait` keeps checking until it's ready |
| `list_videos` | The user's videos on recordful.app, newest first, optionally filtered by title |
| `get_transcript` | **Pro.** What was said, as `text`, `vtt` or both. Transcribes on first use and waits, including for an upload still in progress |

Tools that wait report MCP progress (upload percentage, transcription) to apps that ask for it, and always return within their `timeoutMs`; call again to keep waiting. Without a `videoId`, video tools use the last recording (stopped or uploaded in this browser session), else the newest video in the account.

### Plans

`get_status` reports `recorder.account.plan`: `pro`, `free`, `signed-out`, or `unavailable` (a build without cloud features). Recording, page tools and the editor work on every plan. Uploads, cloud videos and transcripts need Pro: on other plans they fail at once with `PRO_REQUIRED` or `NOT_SIGNED_IN`, whose message says what still works and whose `data` carries `plan` and `upgradeUrl`.

Page tools use synthetic browser events. Links, buttons, checkboxes, form fields and form submits work. Native dropdown popups, file pickers, content inside iframes, and actions that need a real user gesture (opening pop-up windows, the clipboard) don't. Details: [protocol.md](protocol.md#page-methods).

## Prompt

`record_feature(feature, url?)`: the full plan-and-record workflow. In Claude Code it's `/mcp__recordful__record_feature`, or `/record-demo` with the plugin.

## Command line

```text
npx -y recordful-mcp                       run the MCP server (what AI apps start)
npx -y recordful-mcp setup                 print the setup snippet for each AI app
npx -y recordful-mcp install --target <app> [--component all|mcp|skill] [--yes]
                                           add the server (and skill) to one AI app's config: claude, cursor, codex,
                                           opencode, vscode, windsurf, gemini. A dry run unless --yes; merges, never replaces
npx -y recordful-mcp prompt                print the paste-into-any-AI setup prompt
npx -y recordful-mcp guide --json          tools, commands, error codes, plans and safety rules for agents
npx -y recordful-mcp start [--tab <id>]    start recording (click the Recordful icon on the tab first)
npx -y recordful-mcp pause | resume | stop
npx -y recordful-mcp recordings            recordings saved on this computer
npx -y recordful-mcp upload [<takeId>] [--title <t>] [--visibility private|workspace|public] [--force] [--no-wait]
npx -y recordful-mcp videos [--limit <n>] [--query <text>]
npx -y recordful-mcp video [<videoId>] [--wait]
npx -y recordful-mcp transcript [<videoId>] [--format text|vtt|json] [--no-wait]
npx -y recordful-mcp status                connection, recorder, plan and pairing state
npx -y recordful-mcp unpair <id>|--all     forget a paired Recordful (or all)
npx -y recordful-mcp call <method> [json]  call one Recordful method directly, for debugging
```

Every command takes `--json` and `--timeout <ms>` (for the waiting ones). Results go to stdout, progress and errors to stderr; the exit code is 0 on success, 1 on an error, 2 when `transcript` isn't ready yet.

The first command starts a small background helper that holds Recordful's connection, so you click the Recordful icon once rather than before every command. It exits after 30 idle minutes. If an AI app's recordful-mcp is already running, commands use its connection instead.

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

The first recordful-mcp on the computer owns the port; every other one (a second AI app, the CLI) shares its connection, and takes the port over if the owner exits. So any number of AI apps can use Recordful at once.
