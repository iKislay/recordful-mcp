# Recordful MCP

**Let any AI app record, upload and read back product demos with [Recordful](https://recordful.app).**

Ask your AI to *"record how the new sign-up flow works"*. It plans a short walkthrough, asks you to click the Recordful icon on the tab, then navigates, clicks and types with a smooth on-screen cursor while Recordful records. When it stops, Recordful's editor opens with the video. With Recordful Pro, it can also upload the video, hand you the link, and read the transcript back.

It ships as an **MCP server** for AI apps and a **CLI** for anything with a shell.

Works with Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, opencode, Codex, Gemini CLI and any other app that supports the [Model Context Protocol](https://modelcontextprotocol.io). The AI doesn't need a browser of its own. Everything runs on your computer: nothing to host, no account, no API key.

## Install

You need Chrome and [Node.js](https://nodejs.org) 20.10 or newer. The Claude Desktop bundle includes everything, so it doesn't need Node.

**1. Install [Recordful from the Chrome Web Store](https://chromewebstore.google.com/detail/hkcgjbkibidgbefehehenlmhjanjaopc).**

**2. Add the server to your AI app:**

<details open>
<summary><b>Claude Code</b></summary>

The plugin adds the server, a `record-demo` skill and a `/record-demo` command:

```text
/plugin marketplace add iKislay/recordful-mcp
/plugin install recordful@recordful
```

Or add just the server: `claude mcp add --scope user recordful -- npx -y recordful-mcp` (on native Windows, use `cmd /c npx -y recordful-mcp`).
</details>

<details>
<summary><b>Claude Desktop</b></summary>

Download `recordful.mcpb` from the [latest release](https://github.com/iKislay/recordful-mcp/releases/latest) and double-click it. Or add this to `claude_desktop_config.json` (Settings → Developer → Edit Config) and restart Claude:

```json
{ "mcpServers": { "recordful": { "command": "npx", "args": ["-y", "recordful-mcp"] } } }
```
</details>

<details>
<summary><b>Cursor, Windsurf, Gemini CLI and most others</b></summary>

Add to the app's MCP config: `~/.cursor/mcp.json`, `~/.codeium/windsurf/mcp_config.json`, `~/.gemini/settings.json`, and so on:

```json
{ "mcpServers": { "recordful": { "command": "npx", "args": ["-y", "recordful-mcp"] } } }
```
</details>

<details>
<summary><b>VS Code</b></summary>

Run **MCP: Add Server**, or add to `.vscode/mcp.json`:

```json
{ "servers": { "recordful": { "type": "stdio", "command": "npx", "args": ["-y", "recordful-mcp"] } } }
```
</details>

<details>
<summary><b>opencode</b></summary>

Add to `opencode.json`:

```json
{ "mcp": { "recordful": { "type": "local", "command": ["npx", "-y", "recordful-mcp"], "enabled": true } } }
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

`npx -y recordful-mcp setup` prints all of these.

**3. First recording (one-time setup):**

1. In Recordful's popup, click **More → AI agents** and turn it on.
2. Ask your AI to record something. When it asks, click the **Recordful icon** on the tab.
3. Recordful asks you to approve the app. If the 4-digit code matches the one your AI shows, click **Allow**.

After that, you only click the Recordful icon on the tab you want recorded.

## Use it

Ask in plain words:

- "Record a demo of signing up and signing in on localhost:3000."
- "I just built the billing page. Record a short video of how it works."

- "Upload that and give me the link." / "What did I say in the last recording?" (Recordful Pro)

The AI works out the flow, uses test data (never your real accounts), records with pauses while it thinks, and stops so the editor opens. Apps that support MCP prompts also offer **record_feature**, a guided version of this workflow. While an app is connected, Recordful's icon shows an **AI** badge.

### Free and Pro

| | Free | Pro |
| --- | --- | --- |
| Record, drive the page, open in Recordful's editor | ✓ | ✓ |
| Upload to recordful.app and get a link | | ✓ |
| Read back the transcript | | ✓ |

The AI checks your plan first. On the free plan it records as usual and tells you once that links and transcripts come with Pro, instead of failing. Recordings made while signed in to Pro go to the cloud as they record.

### From the command line

The same things work from a terminal, for agents with a shell or for you:

```bash
npx -y recordful-mcp start        # click the Recordful icon on the tab first
npx -y recordful-mcp stop
npx -y recordful-mcp upload --title "Sign-up demo"
npx -y recordful-mcp transcript > transcript.txt
npx -y recordful-mcp videos
```

The first command asks you to click the Recordful icon once; a small helper keeps the connection for later commands and exits after 30 idle minutes. Add `--json` for machine-readable output. All commands: `npx -y recordful-mcp --help`.

**Why the click?** Chrome only lets an extension record a tab after you click it there, and no app can click for you. The click also marks the only tab the AI may act in.

## Do I need to host anything?

No. The server runs on your computer and talks to Recordful over `127.0.0.1`. Recordings stay on your computer unless you, or your AI with Recordful Pro, upload them to recordful.app.

Only cloud-only chat apps (claude.ai or ChatGPT in a browser or on a phone) would need a hosted connector, because they can't run programs on your computer. That's [planned](https://github.com/iKislay/recordful-mcp/blob/main/docs/remote-mcp.md).

## Privacy and security

- **Off until you turn it on**, and off again with one switch.
- **Local only**: the server can't be reached from other devices or from web pages.
- **Paired once per computer** after you approve a matching code. Every connection proves the pairing, and the secret is never resent.
- **Only the official Recordful extension** can connect by default.
- **One tab**: the AI acts only in the tab you handed over.
- **Revocable**: Paired AI apps → Forget on the AI agents page, or `npx -y recordful-mcp unpair --all`.

Details: [SECURITY.md](https://github.com/iKislay/recordful-mcp/blob/main/SECURITY.md).

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "Recordful isn't connected" | Click the Recordful icon on the tab. Still nothing? Check **More → AI agents** is on |
| The AI shows a code | Check it matches in Recordful's window, click **Allow**, tell the AI to continue |
| Recording won't start | Click the Recordful icon on the exact tab to record, then retry |
| Recording waits forever | Recordful may be asking something (microphone access, or the screen picker in screen mode). Answer it |
| `PRO_REQUIRED` or `NOT_SIGNED_IN` | Uploads and transcripts need a Recordful Pro account, signed in in Recordful. Recording works on every plan |
| `BRIDGE_UNAVAILABLE` | Something other than recordful-mcp is using port 47823, or an older recordful-mcp is running. Update or close it |
| No Recordful tools in the AI app | Check `node -v` is 20.10+, then restart the app |

Run `npx -y recordful-mcp status` to see the pairing state.

## More

- [Tools, CLI and configuration](https://github.com/iKislay/recordful-mcp/blob/main/docs/reference.md)
- [How it works: protocol and pairing](https://github.com/iKislay/recordful-mcp/blob/main/docs/protocol.md)
- [Development and releasing](https://github.com/iKislay/recordful-mcp/blob/main/docs/development.md)
- [Changelog](https://github.com/iKislay/recordful-mcp/blob/main/CHANGELOG.md)

## License

[MIT](https://github.com/iKislay/recordful-mcp/blob/main/LICENSE)
