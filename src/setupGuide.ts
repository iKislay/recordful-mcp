// `recordful-mcp setup`: copy-paste configuration for the common AI apps.
// Kept in step with the README's install section.
export const setupGuide = (): string => `Add Recordful to your AI app

The server runs locally with npx: no hosting, no account, no API key.

Claude Code
  Plugin (server + record-demo skill + /record-demo):
    /plugin marketplace add iKislay/recordful-mcp
    /plugin install recordful@recordful
  Or just the server, for all projects:
    claude mcp add --scope user recordful -- npx -y recordful-mcp
  (native Windows: use "cmd /c npx -y recordful-mcp")

Claude Desktop
  Settings → Extensions → install recordful.mcpb (from the GitHub release), or add this to
  claude_desktop_config.json (Settings → Developer → Edit Config):
  { "mcpServers": { "recordful": { "command": "npx", "args": ["-y", "recordful-mcp"] } } }

Cursor  (~/.cursor/mcp.json)
  { "mcpServers": { "recordful": { "command": "npx", "args": ["-y", "recordful-mcp"] } } }

VS Code  (.vscode/mcp.json, or "MCP: Add Server" in the Command Palette)
  { "servers": { "recordful": { "type": "stdio", "command": "npx", "args": ["-y", "recordful-mcp"] } } }

Windsurf  (~/.codeium/windsurf/mcp_config.json)
  { "mcpServers": { "recordful": { "command": "npx", "args": ["-y", "recordful-mcp"] } } }

opencode  (opencode.json)
  { "mcp": { "recordful": { "type": "local", "command": ["npx", "-y", "recordful-mcp"], "enabled": true } } }

Codex CLI  (~/.codex/config.toml)
  [mcp_servers.recordful]
  command = "npx"
  args = ["-y", "recordful-mcp"]

Gemini CLI  (~/.gemini/settings.json)
  { "mcpServers": { "recordful": { "command": "npx", "args": ["-y", "recordful-mcp"] } } }

Any other app that runs local (stdio) MCP servers: command "npx", arguments "-y recordful-mcp".

Then, in Chrome:
  1. Install Recordful: https://chromewebstore.google.com/detail/hkcgjbkibidgbefehehenlmhjanjaopc
  2. First time only: open Recordful's popup → More → AI agents, and turn it on.
  3. Ask your AI to record something, e.g. "Record a demo of the sign-up flow on localhost:3000".
     When it asks, click the Recordful icon on that tab, and approve the pairing code (first time only).
`;
