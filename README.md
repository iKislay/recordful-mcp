# Recordful MCP

**Let any AI app record product demos with [Recordful](https://recordful.app).**

Ask your AI to *"record how the new sign-up flow works"*. It plans a short walkthrough, asks you to click the Recordful icon on the tab, then navigates, clicks and types with a smooth on-screen cursor while Recordful records. When it stops, Recordful's editor opens with the video.

It works with any app that supports the [Model Context Protocol](https://modelcontextprotocol.io), including Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, opencode, Codex and Gemini CLI. The AI doesn't need a browser of its own: Recordful drives the page itself. **It runs entirely on your computer**, so there's nothing to host and no account or API key.

- [Install](#install)
- [Use it](#use-it)
- [Do I need to host anything?](#do-i-need-to-host-anything)
- [Privacy and security](#privacy-and-security)
- [Troubleshooting](#troubleshooting)
- [Reference](#reference): tools, prompt, CLI, configuration
- [Development](#development)

## Install

You need Chrome with Recordful, and Node.js 20.10 or newer (run `node -v` to check; get it at [nodejs.org](https://nodejs.org)).

### 1. Install Recordful

Install [Recordful from the Chrome Web Store](https://chromewebstore.google.com/detail/hkcgjbkibidgbefehehenlmhjanjaopc).

### 2. Add the MCP server to your AI app

Pick your app. Each one runs `npx -y recordful-mcp`, which downloads and starts the server on demand.

<details open>
<summary><b>Claude Code</b></summary>

Install the plugin. It bundles the server, a `record-demo` skill and a `/record-demo` command:

```text
/plugin marketplace add iKislay/recordful-mcp
/plugin install recordful@recordful
```

Or add just the server, for all your projects:

```bash
claude mcp add --scope user recordful -- npx -y recordful-mcp
```

On native Windows (not WSL), use `cmd /c npx -y recordful-mcp` as the command.
</details>

<details>
<summary><b>Claude Desktop</b></summary>

Download `recordful.mcpb` from the [latest release](https://github.com/iKislay/recordful-mcp/releases/latest) and double-click it, or drag it onto Settings → Extensions. It includes everything; you don't need anything else.

Or add this to `claude_desktop_config.json` (Settings → Developer → Edit Config) and restart Claude:

```json
{
  "mcpServers": {
    "recordful": { "command": "npx", "args": ["-y", "recordful-mcp"] }
  }
}
```
</details>

<details>
<summary><b>Cursor</b></summary>

Add to `~/.cursor/mcp.json`, or to `.cursor/mcp.json` in a project:

```json
{
  "mcpServers": {
    "recordful": { "command": "npx", "args": ["-y", "recordful-mcp"] }
  }
}
```
</details>

<details>
<summary><b>VS Code (GitHub Copilot)</b></summary>

Run **MCP: Add Server** from the Command Palette, or add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "recordful": { "type": "stdio", "command": "npx", "args": ["-y", "recordful-mcp"] }
  }
}
```
</details>

<details>
<summary><b>Windsurf</b></summary>

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "recordful": { "command": "npx", "args": ["-y", "recordful-mcp"] }
  }
}
```
</details>

<details>
<summary><b>opencode</b></summary>

Add to `opencode.json`:

```json
{
  "mcp": {
    "recordful": { "type": "local", "command": ["npx", "-y", "recordful-mcp"], "enabled": true }
  }
}
```
</details>

<details>
<summary><b>Codex CLI</b></summary>

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.recordful]
command = "npx"
args = ["-y", "recordful-mcp"]
```
</details>

<details>
<summary><b>Gemini CLI</b></summary>

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "recordful": { "command": "npx", "args": ["-y", "recordful-mcp"] }
  }
}
```
</details>

<details>
<summary><b>Anything else</b></summary>

Any app that runs local (stdio) MCP servers works, including Zed, Cline, Goose, Continue and LM Studio with local models. Use the command `npx` with the arguments `-y recordful-mcp`. Running `npx -y recordful-mcp setup` prints these snippets too.
</details>

### 3. First recording (one-time setup)

1. In Chrome, open Recordful's popup, click **More**, then **AI agents**, and turn on **Let AI apps control Recordful**.
2. Ask your AI to record something. When it asks, **click the Recordful icon** on the tab to record.
3. The first time, Recordful asks you to approve the app. **Check that the 4-digit code matches** the one your AI shows you, then click **Allow**.

That's it. From then on, you only click the Recordful icon on the tab you want recorded.

## Use it

Ask in plain words:

- "Record a demo of signing up and signing in on localhost:3000."
- "I just built the billing page. Record a short video of how it works."
- "Record the onboarding flow on https://example.com, about a minute long."

A good agent will:

1. Work out the flow from your code or the page, and get the app running if needed.
2. Use test data only, never your real accounts.
3. Show you a short shot list, then ask you to click the Recordful icon on the tab.
4. Record, pausing while it thinks so the video has no dead air.
5. Stop, and Recordful's editor opens with the video.

Apps that support MCP prompts also list **record_feature**, a guided version of this workflow. In Claude Code it's `/mcp__recordful__record_feature`, or `/record-demo` with the plugin.

While an AI app is connected, the Recordful icon shows an **AI** badge. Turn the switch off on the AI agents page (popup → More → AI agents) to disconnect immediately.

### Why does it ask me to click the Recordful icon?

Chrome lets an extension record a tab only after you've clicked that extension on the tab. No app, AI or otherwise, can do that click for you. The click also tells Recordful which tab the AI may act in: page tools work only there, never in your other tabs. Screen recording mode shows Chrome's usual screen picker instead.

## Do I need to host anything?

**No.** The MCP server runs on your computer, started by your AI app, and talks to Recordful in your Chrome over a local connection (`127.0.0.1`). Nothing goes through a server, and Recordful's recordings stay in your browser until you choose to share or upload them.

Hosting would only matter for AI chat apps that run entirely in the cloud, such as claude.ai or ChatGPT in a web browser or on a phone. They can't start programs on your computer, so they can't reach a local server. That would need a hosted endpoint (`mcp.recordful.app`) that your Recordful extension connects to. It isn't built yet; [docs/remote-mcp.md](docs/remote-mcp.md) has the plan. Desktop and terminal AI apps don't need it.

## Privacy and security

- **Off until you turn it on.** Recordful makes no connection at all until you switch on AI agents.
- **Local only.** The server listens on `127.0.0.1`, so it can't be reached from another device. Web pages can't connect to it either.
- **Paired, not trusted by default.** Each computer's server pairs with Recordful once, after you approve it against a matching code. Both sides then prove they hold the pairing secret on every connection, and the secret itself is never sent again. A program that grabs the port first can't control Recordful.
- **Only the official extension.** The server accepts the Chrome Web Store build of Recordful, plus any development builds you explicitly allow.
- **One tab.** Page tools act only on the tab you handed over with the Recordful icon, or the tab being recorded.
- **Revocable.** Remove an app on the AI agents page under Paired AI apps, or forget pairings on the computer with `npx -y recordful-mcp unpair --all`.

Details are in [SECURITY.md](SECURITY.md) and [docs/protocol.md](docs/protocol.md).

## Troubleshooting

| What you see | What to do |
| --- | --- |
| The AI says Recordful isn't connected (`NOT_CONNECTED`) | Click the Recordful icon on the tab. If it still doesn't connect, check AI agents is on (popup → More → AI agents), then click the icon again |
| The AI shows a code (`PAIRING_PENDING`) | Recordful opened a small window. Check the code matches, click **Allow**, and tell the AI to continue |
| You clicked **Deny** by mistake | Ask the AI to try again and click the Recordful icon; it asks again |
| `NOT_ARMED`, or recording won't start | Click the Recordful icon on the exact tab to record (after it has loaded), then retry |
| Recording waits and nothing happens | Recordful may be showing a prompt (microphone access, "continue without audio?", or Chrome's screen picker in screen mode). Answer it, or turn off the microphone in Recordful's popup for unattended runs |
| `BRIDGE_UNAVAILABLE` | Another AI app's Recordful server is already running. Use one AI app at a time with Recordful, or close the other; the second one takes over automatically when the first exits |
| The AI doesn't list any Recordful tools | Check `node -v` is 20.10 or newer, and restart the AI app after editing its config |
| Anything else | Run `npx -y recordful-mcp status` for the pairing state, and set `RECORDFUL_BRIDGE_LOG_LEVEL=debug` in the server's environment for detailed logs (your AI app shows the server's log output) |

## Reference

### Tools

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

Page tools use synthetic browser events. Links, buttons, checkboxes, form fields and form submits work. Native dropdown popups, file pickers, content inside iframes, and actions that need a real user gesture (opening pop-up windows, the clipboard) don't. See [docs/protocol.md](docs/protocol.md#page-methods).

### Prompt

`record_feature(feature, url?)`: the full plan-and-record workflow as an MCP prompt.

### Command line

```text
npx -y recordful-mcp                      run the MCP server (what AI apps start)
npx -y recordful-mcp setup                print the setup snippet for each AI app
npx -y recordful-mcp status               show this computer's pairing state
npx -y recordful-mcp unpair <id>|--all    forget a paired Recordful (or all)
npx -y recordful-mcp call <method> [json] call one Recordful method directly, for debugging
```

### Configuration

Everything is optional and set through environment variables, for example in your AI app's `env` block for the server.

| Variable | Default | Purpose |
| --- | --- | --- |
| `RECORDFUL_BRIDGE_PORT` | `47823` | Local port. The Chrome Web Store build of Recordful always uses 47823 |
| `RECORDFUL_BRIDGE_ALLOWED_EXTENSION_IDS` | — | Extra extension IDs allowed to connect, comma-separated, e.g. an unpacked development build. The store build is always allowed; `*` allows any (development only) |
| `RECORDFUL_BRIDGE_STATE_PATH` | `~/.recordful/agent-bridge.json` | Where the pairing is kept |
| `RECORDFUL_BRIDGE_TOKEN` | — | A shared secret instead of pairing, for CI and scripted runs against development builds |
| `RECORDFUL_BRIDGE_REQUEST_TIMEOUT_MS` | `15000` | Base timeout per request (recording calls add their own wait) |
| `RECORDFUL_BRIDGE_CONNECT_WAIT_MS` | `8000` | How long a tool waits for Recordful to connect |
| `RECORDFUL_BRIDGE_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. Logs are JSON lines on stderr |

Only one server can own the port at a time. If two AI apps each start one, the second keeps retrying in the background and takes over when the first exits; until then its tools report `BRIDGE_UNAVAILABLE`.

## Development

```bash
npm install
npm run check        # typecheck + tests
npm run build        # compile to dist/
npm run dev          # run the CLI from source
npm run pack:mcpb    # build recordful.mcpb for Claude Desktop
```

Live end-to-end tests drive a real Recordful build in a throwaway browser profile. They need a development build of Recordful next to this repo (`npm run build:agent` there), and Playwright from that repo. Branded Chrome ignores `--load-extension` since v137, so use Playwright's Chromium or `--channel msedge`.

```bash
# First-run experience: switch on, pairing window, code match, Allow, Deny, reconnects
node scripts/live-pairing.mjs --extension ../recordful/build --channel msedge

# Recording and every page tool (build Recordful with RECORDFUL_AGENT_BRIDGE_TOKEN=<secret>
# and pass the same secret here as RECORDFUL_BRIDGE_TOKEN)
node scripts/live-spike.mjs --extension ../recordful/build --channel msedge --pages
```

To use a development build of Recordful with your AI app, allow its extension ID (shown on `chrome://extensions`) with `RECORDFUL_BRIDGE_ALLOWED_EXTENSION_IDS`.

### Releasing

1. Bump the version in `package.json`, `mcpb/manifest.json`, `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` and `server.json`, and add a `CHANGELOG.md` entry.
2. `npm publish` (runs the checks and a fresh build first).
3. `npm run pack:mcpb` and attach `recordful.mcpb` to a GitHub release.
4. Optionally publish `server.json` to the [MCP Registry](https://registry.modelcontextprotocol.io) with `mcp-publisher publish`.

### Layout

```text
src/
  cli.ts            entry point: serve, setup, status, unpair, call
  config.ts         environment → typed config
  clientNames.ts    MCP client name → the name Recordful shows ("Claude Code")
  setupGuide.ts     `setup` output
  auth/             pairing store, HMAC challenge-response
  bridge/           WebSocket server: pairing, sessions, heartbeat, requests, port supervision
  mcp/              MCP tools and the record_feature prompt
  protocol/         wire messages (zod), methods, page-tool params, error codes
test/               vitest: pairing, handshake security, requests, MCP tools and prompt, config
scripts/            live end-to-end tests, MCPB packer
plugin/             Claude Code plugin: MCP config, record-demo skill, /record-demo command
mcpb/               Claude Desktop extension manifest and icon
docs/               protocol, findings, roadmap, hosted MCP plan
```

The extension side lives in the Recordful repo under `src/pages/Background/agentBridge/` (connection, pairing, commands), `src/pages/Content/agentPage/` (page tools) and `src/pages/Agents/` (the AI agents page and the pairing window).
