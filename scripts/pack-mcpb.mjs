// Builds recordful.mcpb, the one-click Claude Desktop extension: the compiled
// server, its production dependencies, the manifest and the icon.
//
// usage: npm run pack:mcpb   (after npm run build)
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "mcpb", "manifest.json"), "utf8"));

if (manifest.version !== pkg.version) {
  console.error(`mcpb/manifest.json is ${manifest.version} but package.json is ${pkg.version}; keep them in step.`);
  process.exit(1);
}
if (!existsSync(join(root, "dist", "cli.js"))) {
  console.error("Run `npm run build` first.");
  process.exit(1);
}

const stage = mkdtempSync(join(tmpdir(), "recordful-mcpb-"));
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });

try {
  cpSync(join(root, "dist"), join(stage, "dist"), {
    recursive: true,
    filter: (src) => !src.endsWith(".map") && !src.endsWith(".d.ts"),
  });
  cpSync(join(root, "mcpb", "manifest.json"), join(stage, "manifest.json"));
  cpSync(join(root, "mcpb", "icon.png"), join(stage, "icon.png"));
  cpSync(join(root, "package-lock.json"), join(stage, "package-lock.json"));
  const { devDependencies: _dev, scripts: _scripts, ...runtimePkg } = pkg;
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(runtimePkg, null, 2)}\n`);

  run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"], stage);
  run("npx", ["--yes", "@anthropic-ai/mcpb@2.1.2", "validate", "manifest.json"], stage);
  const out = join(root, "recordful.mcpb");
  rmSync(out, { force: true });
  run("npx", ["--yes", "@anthropic-ai/mcpb@2.1.2", "pack", stage, out], root);
  console.log(`\nBuilt ${out}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
