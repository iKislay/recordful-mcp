import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeServer } from "../src/bridge/BridgeServer.js";
import { loadConfig } from "../src/config.js";
import { guide, MCP_TOOLS } from "../src/guide.js";
import { install, TARGETS } from "../src/install.js";
import { silentLogger } from "../src/logger.js";
import { createMcpServer } from "../src/mcp/createMcpServer.js";
import { SETUP_PROMPT } from "../src/setupPrompt.js";
import { SKILL_TEXT } from "../src/skill.js";
import { memoryPairings } from "./helpers/fakeExtension.js";

let dir: string;
const previous = { home: process.env.RECORDFUL_INSTALL_HOME, appdata: process.env.APPDATA };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "recordful-install-"));
  process.env.RECORDFUL_INSTALL_HOME = dir;
  process.env.APPDATA = join(dir, "AppData", "Roaming");
});
afterEach(() => {
  if (previous.home === undefined) delete process.env.RECORDFUL_INSTALL_HOME;
  else process.env.RECORDFUL_INSTALL_HOME = previous.home;
  if (previous.appdata === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = previous.appdata;
});

const read = (...p: string[]) => readFileSync(join(dir, ...p), "utf8");

describe("install", () => {
  it("shows what it would do and writes nothing without apply", () => {
    const r = install("cursor", { apply: false });
    expect(r.applied).toBe(false);
    expect(r.changes.map((c) => `${c.component}:${c.action}`)).toEqual(["mcp:create", "skill:create"]);
    expect(() => read(".cursor", "mcp.json")).toThrow();
    expect(() => read(".cursor", "skills", "record-demo", "SKILL.md")).toThrow();
  });

  it("writes the MCP entry and the skill for Cursor, and a second run changes nothing", () => {
    install("cursor", { apply: true });
    expect(JSON.parse(read(".cursor", "mcp.json"))).toEqual({ mcpServers: { recordful: { command: "npx", args: ["-y", "recordful-mcp"] } } });
    expect(read(".cursor", "skills", "record-demo", "SKILL.md")).toBe(SKILL_TEXT);
    const again = install("cursor", { apply: true });
    expect(again.changes.map((c) => c.action)).toEqual(["unchanged", "unchanged"]);
  });

  it("keeps other servers and settings when it merges", () => {
    mkdirSync(join(dir, ".cursor"), { recursive: true });
    writeFileSync(join(dir, ".cursor", "mcp.json"), JSON.stringify({ theme: "x", mcpServers: { other: { command: "node" } } }));
    const r = install("cursor", { apply: true, component: "mcp" });
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]?.action).toBe("update");
    expect(JSON.parse(read(".cursor", "mcp.json"))).toEqual({
      theme: "x",
      mcpServers: { other: { command: "node" }, recordful: { command: "npx", args: ["-y", "recordful-mcp"] } },
    });
  });

  it("updates an outdated recordful entry", () => {
    mkdirSync(join(dir, ".gemini"), { recursive: true });
    writeFileSync(join(dir, ".gemini", "settings.json"), JSON.stringify({ mcpServers: { recordful: { command: "old" } } }));
    expect(install("gemini", { apply: true }).changes[0]?.action).toBe("update");
    expect(JSON.parse(read(".gemini", "settings.json")).mcpServers.recordful.command).toBe("npx");
  });

  it("leaves a file it cannot parse alone and says what to add", () => {
    mkdirSync(join(dir, ".config", "opencode"), { recursive: true });
    const text = '{\n  // my settings\n  "theme": "x"\n}\n';
    writeFileSync(join(dir, ".config", "opencode", "opencode.json"), text);
    const change = install("opencode", { apply: true }).changes[0];
    expect(change?.action).toBe("manual");
    expect(change?.detail).toContain('"recordful"');
    expect(read(".config", "opencode", "opencode.json")).toBe(text);
  });

  it("uses each app's own entry shape", () => {
    install("opencode", { apply: true });
    expect(JSON.parse(read(".config", "opencode", "opencode.json")).mcp.recordful).toEqual({
      type: "local",
      command: ["npx", "-y", "recordful-mcp"],
      enabled: true,
    });
    install("vscode", { apply: true });
    const vscodePath =
      process.platform === "win32"
        ? ["AppData", "Roaming", "Code", "User", "mcp.json"]
        : process.platform === "darwin"
          ? ["Library", "Application Support", "Code", "User", "mcp.json"]
          : [".config", "Code", "User", "mcp.json"];
    expect(JSON.parse(read(...vscodePath)).servers.recordful.type).toBe("stdio");
    install("windsurf", { apply: true });
    expect(JSON.parse(read(".codeium", "windsurf", "mcp_config.json")).mcpServers.recordful.command).toBe("npx");
  });

  it("appends to Codex's TOML without touching what is there, once", () => {
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(join(dir, ".codex", "config.toml"), 'model = "x"\n\n[mcp_servers.other]\ncommand = "node"\n');
    expect(install("codex", { apply: true, component: "mcp" }).changes[0]?.action).toBe("update");
    const toml = read(".codex", "config.toml");
    expect(toml).toContain('model = "x"');
    expect(toml).toContain("[mcp_servers.other]");
    expect(toml).toContain("[mcp_servers.recordful]");
    expect(install("codex", { apply: true, component: "mcp" }).changes[0]?.action).toBe("unchanged");
    expect(read(".codex", "config.toml")).toBe(toml);
  });

  it("only writes skills for apps that read them, and respects --component", () => {
    expect(install("windsurf", { apply: false }).changes.map((c) => c.component)).toEqual(["mcp"]);
    expect(install("claude", { apply: false, component: "skill" }).changes.map((c) => c.component)).toEqual(["skill"]);
    for (const t of TARGETS) expect(install(t, { apply: false, component: "skill" }).restart.length).toBeGreaterThan(10);
  });

  it("keeps the installed skill and the plugin's skill identical", () => {
    const plugin = readFileSync(new URL("../plugin/skills/record-demo/SKILL.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    expect(SKILL_TEXT).toBe(plugin);
  });
});

describe("guide and prompt", () => {
  it("lists exactly the tools the MCP server registers", async () => {
    const config = { ...loadConfig({}), port: 0 };
    const bridge = new BridgeServer({
      port: 0,
      pairings: memoryPairings(),
      pairingTimeoutMs: 1_000,
      allowedExtensionIds: [],
      handshakeTimeoutMs: 1_000,
      heartbeatTimeoutMs: 60_000,
      logger: silentLogger,
    });
    const server = createMcpServer({ bridge, config, logger: silentLogger, version: "0.0.0-test" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(b), client.connect(a)]);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    await client.close();
    expect([...MCP_TOOLS].sort()).toEqual(names);
  });

  it("describes the install targets, exit codes and safety rules", () => {
    const g = guide("1.2.3");
    expect(g.version).toBe("1.2.3");
    expect(g.installTargets).toEqual([...TARGETS]);
    expect(g.exitCodes["2"]).toContain("transcript");
    expect(g.safety.join(" ")).toContain("Ask the user before recording");
    expect(g.errorCodes).toContain("PRO_REQUIRED");
    expect(g.errorCodes).toContain("PERMISSIONS_NEEDED");
  });

  it("gives a setup prompt that names every target and the real commands", () => {
    for (const t of TARGETS) expect(SETUP_PROMPT).toContain(t);
    expect(SETUP_PROMPT).toContain("install --target <app> --yes --json");
    expect(SETUP_PROMPT).toContain("guide --json");
  });
});
