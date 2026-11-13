# Changelog

## 1.1.2 (2026-11-13)

- **The repo is the plugin.** The Claude Code plugin's `.mcp.json`, `record-demo` skill and `/record-demo` command moved from `plugin/` to the repo root, in the [Open Plugins](https://open-plugins.com) layout, so plugin directories such as Cursor Directory find them. `/plugin marketplace add iKislay/recordful-mcp` works as before. The npm package is the same as 1.1.1 apart from the version.

## 1.1.1 (2026-11-13)

- The relay starts under Claude Desktop too. Claude Desktop can run the `.mcpb` server on its own Electron runtime, and the relay's launcher then started the Claude app instead of the relay. 1.1.0 was tagged but never published; use 1.1.1.

## 1.1.0 (2026-11-13)

No more toolbar click for everything. With Recordful 4.7.0, the only click left is the one Chrome requires to record a tab.

- **Recordful connects by itself.** Each time the server (or the CLI helper) starts, it registers a native-messaging relay, `recordful-mcp native-host` (`app.recordful.bridge`), for Chrome, Edge, Brave and Chromium: a launcher and manifest in `~/.recordful/native-host`, plus a per-user registry key on Windows or a manifest in each installed browser's folder on macOS and Linux. Chrome starts the relay when AI agents is on, the relay tells Recordful when the bridge is up, and Recordful joins with no click, no polling and nothing logged on chrome://extensions. It only carries frames: pairing stays end to end, and the first pairing still takes a click. Without it, the icon click works as before.
- **Agents get a tab of their own.** With no tab handed over, `navigate` opens one (`openedTab: true`), so page tools and `take_screenshot` need no click. The user's other tabs stay out of reach. For a tab or tab-area recording there, the user clicks the Recordful icon on that tab once, and `start_recording` says so at once.
- The instructions, the record-demo skill, the setup prompt and the guide only ask for the click where it's still needed. The Claude Code plugin's version now follows the package.

## 1.0.0 (2026-11-12)

Screenshots of the whole desktop, not just a browser tab, through the Recordful desktop app. A major version: recordful-mcp now drives two Recordful apps, the Chrome extension and the desktop app.

- **`take_screenshot` takes a `source`**: `"tab"` (the default, as before), or with the Recordful desktop app 2.0 `"screen"` (`display`: 1, 2… or `"main"`), `"window"` (`window`: part of a title or app name) or `"area"` (the user drags it). The screenshot opens in the app's editor with a notification naming the agent; no image comes back. CLI: `recordful-mcp screenshot --source screen|window|area [--window <name>] [--display <n>] [--look 3d]`.
- **`list_windows`** (CLI: `recordful-mcp windows`): the desktop's open windows, app and title only.
- **How it connects:** the user turns on Settings → AI agents → "Let AI agents take screenshots" in the desktop app once. The app then opens a localhost endpoint and writes its port and a random token to `~/.recordful/desktop-agent.json` (this user only); recordful-mcp reads it. No pairing, no icon click; requests with a browser Origin are refused. Off, or the app closed, the tool says what to ask the user.
- **Default look:** with no `look`, a new screenshot (tab or desktop) starts on a wallpaper picked to match its colours, with rounder corners (recordful.app and the desktop app).
- The `.mcpb` manifest now lists every tool, including the library tools from 0.6.0.

## 0.8.0 (2026-11-12)

Screenshots: your AI app takes a Recordful screenshot and it opens in the screenshot editor.

- **`take_screenshot`** (CLI: `recordful-mcp screenshot [--page] [--look 3d]`): a Recordful screenshot of the handed-over tab, visible part or whole page, opened in Recordful's screenshot editor in the user's usual look, or `look: "3d"` / a preset name when they ask for one. Returns no image, so it costs a few tokens. Needs Recordful 4.6.33 or newer (`shot.take`). The AI's cursor and Stop chip stay out of the picture.
- `install --target antigravity` writes `~/.gemini/antigravity/mcp_config.json`.

## 0.7.0 (2026-11-01)

Mark moments while recording, and let the user stop an agent from the page.

- **`add_marker`**: label a moment of the running recording ("signed in", "error shown"). It's timed in the video, pauses left out, and `stop_recording` now returns every marker as `{ atMs, label }`. The instructions and the skill tell agents to mark moments worth finding again. Needs Recordful 4.6.27 or newer (`recording.marker`).
- Recordful 4.6.27 shows a chip with a Stop button on the tab an agent is driving; Stop ends the session and the extension doesn't reconnect until the user clicks its icon again.
- Internal: the MCP tools and prompt now live in a transport-agnostic core (`src/core`) behind a `RecorderTransport` interface, so the coming hosted connector (mcp.recordful.app) can serve the same tools. No change for users: same tools, instructions, prompt and results.

## 0.6.0 (2026-10-24)

Manage what's on recordful.app, not just upload to it (Recordful Pro).

- **Nine new tools and matching commands**: `update_video` (rename, who may watch), `get_video_activity` (views, likes, every comment), `comment_on_video`, `like_video`, `list_folders`, `create_folder`, `move_videos`, `delete_video` and `get_storage`. CLI: `update`, `activity`, `comment --body`, `like [--undo]`, `folders`, `folder-create`, `move --to`, `delete --yes`, `storage`.
- **Safe by design.** `delete_video` has no default video and needs `confirm: true` (the CLI needs `--yes`), so an agent can't delete by accident. Instructions, the skill and `guide --json` tell agents to show the user exactly what they'll change and wait for a yes before renaming, changing who can watch, commenting (comments are public to everyone who can watch), moving or deleting. Other workspaces' videos answer "not found"; only the recorder or the workspace owner can change a video.
- `list_videos` and `get_video` now include each video's `folderId`.
- New `FORBIDDEN` error for "only the person who recorded it, or the workspace owner, can do that".
- Needs Recordful 4.6.19 or newer and recordful.app with `GET /videos/:id/engagement` and `GET /folders`. Verified live against recordful-ee and its database: rename and privacy, like and comment, reading the activity back, folders, moving in and out, storage, delete, and that a free account and another workspace are refused where they should be.

## 0.5.0 (2026-10-22)

Set up in one step, from any AI app.

- **`recordful-mcp install --target <app>`** adds the server (and, for Claude Code, Cursor and Codex, the `record-demo` skill) to one AI app's own configuration: `claude`, `cursor`, `codex`, `opencode`, `vscode`, `windsurf` or `gemini`. It's a dry run until `--yes`, merges instead of replacing, leaves a config it can't parse alone (with the entry to add by hand), and says whether the app needs a restart.
- **`recordful-mcp prompt`** prints a prompt to paste into any AI app so it installs and verifies Recordful for itself, reports the paths it wrote, lists the few steps only the user can do in Chrome, and then asks what to record. Also on the help center.
- **`recordful-mcp guide --json`**: tools, commands, error codes, exit codes, plans and safety rules in one document, so an agent reads the installed contract instead of guessing. Skills and the prompt tell agents to use Recordful's tools or CLI, never their own browser, to record.
- **First recording no longer fails on a new install.** Recordful needs three browser permissions the first time it records, and Chrome only asks on a click, so an agent's first start used to fail with a vague `START_FAILED`. Turning on AI agents now asks for them, and `start_recording` returns `PERMISSIONS_NEEDED` straight away, with what to tell the user, if they're still missing. (Needs Recordful 4.6.19.)
- The skill has a Rules section (ask before recording and before uploading, test data only, never ask for a secret) and a command-line fallback for sessions where the MCP tools aren't loaded yet.

## 0.4.0 (2026-10-22)

Record, upload and read back: coding assistants can now share a demo and check what was said, on their own, from MCP or a shell.

- **Uploads** (`upload_recording`, Recordful Pro): uploads a local recording to recordful.app with the same steps as the web editor, signed in as the user through the extension (no credential ever reaches the agent), and waits until it's up. Never uploads the same recording twice unless `force`. Cloud recordings are recognised and returned as already uploading.
- **Transcripts** (`get_transcript`, Recordful Pro): starts transcription on first use and waits for it, including for an upload still in progress; returns `text`, `vtt` or both.
- **Videos**: `get_video` (links and upload stage, optionally waiting until ready), `list_videos`, `list_recordings` (local recordings). `stop_recording` now says where the recording went: a cloud video with its links, or a local recording to upload.
- **Clear about plans**: `get_status` reports `plan` (`pro`, `free`, `signed-out`, `unavailable`). On other plans, uploads and transcripts fail at once with `PRO_REQUIRED` or `NOT_SIGNED_IN`, saying what still works (recording, page tools, the editor) and linking the upgrade page; the agent instructions, prompt and skill tell agents to check first and not retry.
- **A real CLI**: `start`, `pause`, `resume`, `stop`, `recordings`, `upload`, `videos`, `video`, `transcript`, `status`, each with readable output or `--json`. The first command starts a small background helper that holds Recordful's connection, so the user clicks the Recordful icon once.
- **Any number of AI apps at once**: a second recordful-mcp (another AI app, or the CLI) shares the first one's connection over an authenticated local peer channel, and takes the port over when the owner exits. `BRIDGE_UNAVAILABLE` now only means something else holds the port.
- MCP progress notifications while uploads and transcripts wait.
- Fixed: two recordful-mcp processes creating the pairing file at the same moment could disagree on the server's identity.
- Tests: 112, including the real CLI end to end and peer takeover. Verified live against recordful.app's stack: a spoken recording uploaded, transcribed and read back through both the CLI and MCP; free and signed-out accounts get clear answers.
- Needs Recordful 4.6.19 or newer (with the upload and transcript methods) and recordful.app with `GET /videos/:id/transcript?text=1`.

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
