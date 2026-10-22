// Regenerates src/skill.ts from the plugin's SKILL.md. Run after editing the skill.
import { readFileSync, writeFileSync } from "node:fs";

const text = readFileSync(new URL("../plugin/skills/record-demo/SKILL.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
writeFileSync(
  new URL("../src/skill.ts", import.meta.url),
  `// The Recordful skill (SKILL.md) that \`recordful-mcp install\` writes for the AI app.
// Generated from plugin/skills/record-demo/SKILL.md by scripts/sync-skill.mjs; a test keeps them equal.
export const SKILL_TEXT = ${JSON.stringify(text)};
`,
);
console.log("src/skill.ts updated");
