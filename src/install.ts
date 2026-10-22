// `recordful-mcp install --target <app>`: writes the Recordful MCP entry (and,
// where the app has skills, the Recordful skill) into one AI app's own
// configuration. It merges, never replaces: other servers and settings stay as
// they are, and a file it can't parse is left alone with the entry to add by hand.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { SKILL_TEXT } from "./skill.js";

export const TARGETS = ["claude", "cursor", "codex", "opencode", "vscode", "windsurf", "gemini"] as const;
export type Target = (typeof TARGETS)[number];
export const COMPONENTS = ["all", "mcp", "skill"] as const;
export type Component = (typeof COMPONENTS)[number];

export const TARGET_NAMES: Record<Target, string> = {
  claude: "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
  opencode: "opencode",
  vscode: "VS Code",
  windsurf: "Windsurf",
  gemini: "Gemini CLI",
};

export interface Change {
  component: "mcp" | "skill";
  // create / update: written (or would be); unchanged: already as wanted;
  // run: a command was (or would be) run; manual: the user has to do it.
  action: "create" | "update" | "unchanged" | "run" | "manual";
  path?: string;
  command?: string;
  detail?: string;
}

export interface InstallResult {
  target: Target;
  name: string;
  applied: boolean;
  changes: Change[];
  restart: string;
}

const SERVER = "recordful";
const NPX_ARGS = ["-y", "recordful-mcp"];

// RECORDFUL_INSTALL_HOME exists for tests; nobody needs it otherwise.
const home = (): string => process.env.RECORDFUL_INSTALL_HOME || homedir();
const isWindows = (): boolean => platform() === "win32";

const readText = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null);
const writeText = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// Merges `entry` under `section.recordful` in a JSON config file.
const mergeJson = (path: string, section: string, entry: unknown, apply: boolean): Change => {
  const wanted = { [section]: { [SERVER]: entry } };
  const manual = (why: string): Change => ({
    component: "mcp",
    action: "manual",
    path,
    detail: `${why} Add this to ${path} yourself:\n${JSON.stringify(wanted, null, 2)}`,
  });
  const text = readText(path);
  let doc: Record<string, unknown> = {};
  if (text !== null && text.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return manual("The file isn't a JSON object.");
      doc = parsed as Record<string, unknown>;
    } catch {
      return manual("Couldn't read the file as plain JSON (comments?), so it was left alone.");
    }
  }
  const current = doc[section];
  if (current !== undefined && (typeof current !== "object" || current === null || Array.isArray(current))) {
    return manual(`"${section}" in the file isn't an object.`);
  }
  const servers = (current ?? {}) as Record<string, unknown>;
  if (sameJson(servers[SERVER], entry)) return { component: "mcp", action: "unchanged", path };
  const action = servers[SERVER] === undefined && text === null ? "create" : "update";
  if (apply) writeText(path, `${JSON.stringify({ ...doc, [section]: { ...servers, [SERVER]: entry } }, null, 2)}\n`);
  return { component: "mcp", action, path };
};

const codexToml = (): string => {
  const command = isWindows() ? "cmd" : "npx";
  const args = isWindows() ? ["/c", "npx", ...NPX_ARGS] : NPX_ARGS;
  return `[mcp_servers.${SERVER}]\ncommand = ${JSON.stringify(command)}\nargs = [${args.map((a) => JSON.stringify(a)).join(", ")}]\n`;
};

const mergeCodex = (apply: boolean): Change => {
  const path = join(home(), ".codex", "config.toml");
  const text = readText(path);
  if (text !== null && new RegExp(`^\\s*\\[mcp_servers\\.${SERVER}\\]`, "m").test(text)) return { component: "mcp", action: "unchanged", path };
  if (apply) writeText(path, `${text === null || text.trim() === "" ? "" : `${text.replace(/\s*$/, "")}\n\n`}${codexToml()}`);
  return { component: "mcp", action: text === null ? "create" : "update", path };
};

const claudeAddArgs = (): string[] => [
  "mcp",
  "add",
  "--scope",
  "user",
  SERVER,
  "--",
  ...(isWindows() ? ["cmd", "/c", "npx"] : ["npx"]),
  ...NPX_ARGS,
];

// On Windows claude is a .cmd shim, which only runs through a shell; the arguments are fixed words, so one command line is safe.
const runClaude = (args: string[]) =>
  isWindows()
    ? spawnSync(["claude", ...args].join(" "), { encoding: "utf8", shell: true, timeout: 60_000 })
    : spawnSync("claude", args, { encoding: "utf8", timeout: 60_000 });

const mergeClaude = (apply: boolean): Change => {
  const args = claudeAddArgs();
  const text = `claude ${args.join(" ")}`;
  const have = runClaude(["mcp", "get", SERVER]);
  // 127 / 9009 are "command not found" from the shell on Linux/macOS and cmd.exe.
  if (have.error || have.status === null || have.status === 127 || have.status === 9009) {
    return { component: "mcp", action: "manual", command: text, detail: `The claude command isn't on PATH. Run this yourself: ${text}` };
  }
  if (have.status === 0) return { component: "mcp", action: "unchanged", command: `claude mcp get ${SERVER}` };
  if (!apply) return { component: "mcp", action: "run", command: text };
  const added = runClaude(args);
  if (added.status !== 0) {
    const why = (added.stderr || added.stdout || "").trim().slice(0, 200);
    return { component: "mcp", action: "manual", command: text, detail: `claude mcp add failed (${why}). Run it yourself: ${text}` };
  }
  return { component: "mcp", action: "run", command: text };
};

const vscodeUserDir = (): string => {
  if (isWindows()) return join(process.env.APPDATA || join(home(), "AppData", "Roaming"), "Code", "User");
  if (platform() === "darwin") return join(home(), "Library", "Application Support", "Code", "User");
  return join(home(), ".config", "Code", "User");
};

// Where each app reads global skills from (SKILL.md in a folder).
const SKILL_DIRS: Partial<Record<Target, string>> = {
  claude: ".claude",
  cursor: ".cursor",
  codex: ".codex",
};

const installSkill = (target: Target, apply: boolean): Change | null => {
  const dir = SKILL_DIRS[target];
  if (!dir) return null;
  const path = join(home(), dir, "skills", "record-demo", "SKILL.md");
  const text = readText(path);
  if (text !== null && text.replace(/\r\n/g, "\n") === SKILL_TEXT) return { component: "skill", action: "unchanged", path };
  if (apply) writeText(path, SKILL_TEXT);
  return { component: "skill", action: text === null ? "create" : "update", path };
};

const installMcp = (target: Target, apply: boolean): Change => {
  switch (target) {
    case "claude":
      return mergeClaude(apply);
    case "cursor":
      return mergeJson(join(home(), ".cursor", "mcp.json"), "mcpServers", { command: "npx", args: NPX_ARGS }, apply);
    case "windsurf":
      return mergeJson(join(home(), ".codeium", "windsurf", "mcp_config.json"), "mcpServers", { command: "npx", args: NPX_ARGS }, apply);
    case "gemini":
      return mergeJson(join(home(), ".gemini", "settings.json"), "mcpServers", { command: "npx", args: NPX_ARGS }, apply);
    case "vscode":
      return mergeJson(join(vscodeUserDir(), "mcp.json"), "servers", { type: "stdio", command: "npx", args: NPX_ARGS }, apply);
    case "opencode":
      return mergeJson(
        join(home(), ".config", "opencode", "opencode.json"),
        "mcp",
        { type: "local", command: ["npx", ...NPX_ARGS], enabled: true },
        apply,
      );
    case "codex":
      return mergeCodex(apply);
  }
};

const RESTART: Record<Target, string> = {
  claude: "Restart Claude Code (or run /mcp) so it loads the server and the skill.",
  cursor: "Restart Cursor (or toggle the server in Settings → MCP) so it loads the server and the skill.",
  codex: "Restart Codex so it loads the server and the skill.",
  opencode: "Restart opencode, then run `opencode mcp list` to check the server.",
  vscode: 'In VS Code, run "MCP: List Servers" and start recordful (or reload the window).',
  windsurf: "Restart Windsurf (or refresh MCP servers in Cascade).",
  gemini: "Restart Gemini CLI, then run /mcp to check the server.",
};

export const install = (target: Target, opts: { apply: boolean; component?: Component }): InstallResult => {
  const component = opts.component ?? "all";
  const changes: Change[] = [];
  if (component !== "skill") changes.push(installMcp(target, opts.apply));
  if (component !== "mcp") {
    const skill = installSkill(target, opts.apply);
    if (skill) changes.push(skill);
  }
  return { target, name: TARGET_NAMES[target], applied: opts.apply, changes, restart: RESTART[target] };
};

export const isTarget = (value: unknown): value is Target => typeof value === "string" && (TARGETS as readonly string[]).includes(value);
export const isComponent = (value: unknown): value is Component => typeof value === "string" && (COMPONENTS as readonly string[]).includes(value);
