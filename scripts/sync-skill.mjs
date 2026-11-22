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

// Only the SKILLS literal is generated; the rest of src/skill.ts is written by hand.
const target = new URL("../src/skill.ts", import.meta.url);
const block = /export const SKILLS: Record<string, Record<string, string>> = [\s\S]*?\n};\n/;
const source = readFileSync(target, "utf8").replace(/\r\n/g, "\n");
if (!block.test(source)) throw new Error("src/skill.ts has no SKILLS block to replace");
const literal = `export const SKILLS: Record<string, Record<string, string>> = ${JSON.stringify(skills, null, 2)};\n`;
writeFileSync(target, source.replace(block, () => literal));
console.log(`src/skill.ts updated: ${Object.keys(skills).join(", ")}`);
