// Regenerates src/skill.ts from the plugin's skills (skills/<name>/**/*.md).
// Run after editing a skill; a test keeps them equal.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../skills/", import.meta.url));
const filesOf = (dir) =>
  readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? filesOf(path) : name.endsWith(".md") ? [path] : [];
    });

const skills = {};
for (const name of readdirSync(root).sort()) {
  const dir = join(root, name);
  if (!statSync(dir).isDirectory()) continue;
  skills[name] = Object.fromEntries(
    filesOf(dir).map((path) => [
      relative(dir, path).replace(/\\/g, "/"),
      readFileSync(path, "utf8").replace(/\r\n/g, "\n"),
    ]),
  );
}

writeFileSync(
  new URL("../src/skill.ts", import.meta.url),
  `// The Recordful skills that \`recordful-mcp install\` writes for the AI app,
// by skill and by file inside it. Generated from skills/ by
// scripts/sync-skill.mjs; a test keeps them equal.
export const SKILLS: Record<string, Record<string, string>> = ${JSON.stringify(skills, null, 2)};

/** The record-demo skill's SKILL.md. */
export const SKILL_TEXT = SKILLS["record-demo"]!["SKILL.md"]!;
`,
);
console.log(`src/skill.ts updated: ${Object.keys(skills).join(", ")}`);
