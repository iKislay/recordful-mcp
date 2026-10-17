// Turns an MCP client's self-reported identity into the name Recordful shows
// in its pairing window. Clients send machine names ("claude-code"); people
// should read "Claude Code".
const KNOWN: Record<string, string> = {
  "claude-code": "Claude Code",
  "claude-ai": "Claude",
  "claude-desktop": "Claude",
  "cursor-vscode": "Cursor",
  cursor: "Cursor",
  "visual studio code": "VS Code",
  "visual-studio-code": "VS Code",
  vscode: "VS Code",
  windsurf: "Windsurf",
  zed: "Zed",
  opencode: "opencode",
  "codex-mcp-client": "Codex",
  codex: "Codex",
  "gemini-cli-mcp-client": "Gemini CLI",
  goose: "Goose",
  continue: "Continue",
  cline: "Cline",
  "roo-code": "Roo Code",
  "lm-studio": "LM Studio",
};

export const appDisplayName = (client: { name: string; title?: string | undefined }): string => {
  if (client.title?.trim()) return client.title.trim();
  const known = KNOWN[client.name.trim().toLowerCase()];
  if (known) return known;
  return client.name
    .trim()
    .replace(/[-_]+/g, " ")
    .replace(/\b(mcp|client)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || "an AI app";
};
