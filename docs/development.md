# Development

```bash
npm install
npm run check        # typecheck + tests
npm run build        # compile to dist/
npm run dev          # run the CLI from source
npm run pack:mcpb    # build recordful.mcpb for Claude Desktop
```

## Live end-to-end tests

These drive a real Recordful build in a throwaway browser profile. They need a development build of Recordful next to this repo (`npm run build:agent` there) and Playwright from that repo. Branded Chrome ignores `--load-extension` since v137, so use Playwright's Chromium or `--channel msedge`.

```bash
# First-run experience: switch on, pairing window, code match, Allow, Deny, reconnects
node scripts/live-pairing.mjs --extension ../recordful/build --channel msedge

# Recording and every page tool. Build Recordful with RECORDFUL_AGENT_BRIDGE_TOKEN=<secret>
# and pass the same secret here as RECORDFUL_BRIDGE_TOKEN.
node scripts/live-spike.mjs --extension ../recordful/build --channel msedge --pages
```

To use a development build of Recordful with your AI app, allow its extension ID (shown on `chrome://extensions`) with `RECORDFUL_BRIDGE_ALLOWED_EXTENSION_IDS`.

## Releasing

1. Bump the version in `package.json`, `mcpb/manifest.json`, `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` and `server.json`, and add a `CHANGELOG.md` entry.
2. `npm publish` (runs the checks and a fresh build first).
3. `npm run pack:mcpb` and attach `recordful.mcpb` to a GitHub release.
4. Optionally publish `server.json` to the [MCP Registry](https://registry.modelcontextprotocol.io) with `mcp-publisher publish`.

## Layout

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
docs/               protocol, reference, findings, roadmap, hosted MCP plan
```

The extension side lives in the Recordful repo under `src/pages/Background/agentBridge/` (connection, pairing, commands), `src/pages/Content/agentPage/` (page tools) and `src/pages/Agents/` (the AI agents page and the pairing window).
