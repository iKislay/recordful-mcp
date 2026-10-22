// Writes the setup-prompt page of the help center (recordful-help) from the prompt
// `recordful-mcp prompt` prints, so the two never differ.
// usage: node scripts/sync-help-prompt.mjs <path to recordful-help>   (needs `npm run build` first)
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SETUP_PROMPT } from "../dist/setupPrompt.js";

const help = process.argv[2];
if (!help) {
  console.error("usage: node scripts/sync-help-prompt.mjs <path to recordful-help>");
  process.exit(2);
}

const page = `---
title: One-prompt setup
description: Paste one prompt into Claude Code, Cursor, Codex, opencode or any AI app and it sets Recordful up for itself.
---

Copy the prompt below into your AI app. It installs the Recordful server and skill for that one app, checks the result, tells you what needs a restart and the few steps only you can do in Chrome, then asks what you want to record. You can also print it with \`npx -y recordful-mcp prompt\`.

The prompt authorizes only local setup for the app you paste it into. It does not let the AI record, upload or change anything on recordful.app without asking you first.

\`\`\`\`text
${SETUP_PROMPT.trimEnd()}
\`\`\`\`

## What it does

1. Picks the right app (\`claude\`, \`cursor\`, \`codex\`, \`opencode\`, \`vscode\`, \`windsurf\` or \`gemini\`) and runs \`recordful-mcp install --target <app>\` as a dry run, then with \`--yes\`.
2. Reads \`recordful-mcp guide --json\`, the list of everything this version can do, instead of relying on memory.
3. Reports the exact files it changed and whether your app must restart to load them.
4. Asks you to install Recordful, turn on AI agents, click the icon on the tab and approve the pairing code. Those clicks have to be yours.

Prefer to do it yourself? See [Set up your AI app](/docs/ai-agents/setup).
`;

writeFileSync(join(resolve(help), "content", "docs", "ai-agents", "setup-prompt.mdx"), page);
console.log("setup-prompt.mdx written");
