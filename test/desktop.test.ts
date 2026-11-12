import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeServer } from "../src/bridge/BridgeServer.js";
import { loadConfig } from "../src/config.js";
import { desktopCall } from "../src/desktop.js";
import { silentLogger } from "../src/logger.js";
import { createMcpServer } from "../src/mcp/createMcpServer.js";
import { memoryPairings } from "./helpers/fakeExtension.js";

// A stand-in for the Recordful desktop app's endpoint (recordful-app
// electron/agentScreenshots.ts), and the file it writes.
let dir: string;
let app: Server | null = null;
const seen: { method?: string; url?: string; auth?: string; body: unknown }[] = [];

const startApp = async (status = 200, answer: unknown = { ok: true, path: "/shot.png" }) => {
  app = createServer((request: IncomingMessage, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push({
        method: request.method,
        url: request.url,
        auth: request.headers.authorization,
        body: body ? JSON.parse(body) : null,
      });
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => app!.listen(0, "127.0.0.1", resolve));
  const { port } = app.address() as AddressInfo;
  writeFileSync(process.env.RECORDFUL_DESKTOP_AGENT_FILE!, JSON.stringify({ port, token: "t0ken" }));
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "recordful-desktop-"));
  process.env.RECORDFUL_DESKTOP_AGENT_FILE = join(dir, "desktop-agent.json");
  seen.length = 0;
});
afterEach(async () => {
  await new Promise<void>((resolve) => (app ? app.close(() => resolve()) : resolve()));
  app = null;
  rmSync(dir, { recursive: true, force: true });
  delete process.env.RECORDFUL_DESKTOP_AGENT_FILE;
});

describe("desktopCall", () => {
  it("says how to turn it on when the app hasn't written its file", async () => {
    await expect(desktopCall("/status")).rejects.toMatchObject({
      code: "NOT_CONNECTED",
      data: { hint: expect.stringContaining("Let AI agents take screenshots") },
    });
  });

  it("says the app isn't running when nothing answers", async () => {
    writeFileSync(process.env.RECORDFUL_DESKTOP_AGENT_FILE!, JSON.stringify({ port: 1, token: "x" }));
    await expect(desktopCall("/status")).rejects.toMatchObject({ message: expect.stringContaining("isn't running") });
  });

  it("sends the token, and takes a 401 as turned off", async () => {
    await startApp(401, { error: "unauthorized" });
    await expect(desktopCall("/status")).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    expect(seen[0]?.auth).toBe("Bearer t0ken");
  });
});

describe("take_screenshot from the desktop", () => {
  const connect = async () => {
    const bridge = new BridgeServer({
      port: 0,
      pairings: memoryPairings(),
      pairingTimeoutMs: 1_000,
      allowedExtensionIds: [],
      handshakeTimeoutMs: 1_000,
      heartbeatTimeoutMs: 60_000,
      logger: silentLogger,
    });
    await bridge.start();
    const server = createMcpServer({ bridge, config: { ...loadConfig({}), port: 0 }, logger: silentLogger, version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "Claude Code", version: "1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, close: async () => (await client.close(), await bridge.stop()) };
  };

  it("asks the app for a window, with the look and who asked, without the extension", async () => {
    await startApp();
    const { client, close } = await connect();
    const result = await client.callTool({
      name: "take_screenshot",
      arguments: { source: "window", window: "Figma", look: "3d" },
    });
    await close();
    expect(result.isError).toBeFalsy();
    expect(seen).toEqual([
      {
        method: "POST",
        url: "/screenshot",
        auth: "Bearer t0ken",
        body: { source: "window", window: "Figma", look: "3d", agent: "Claude Code" },
      },
    ]);
  });

  it("list_windows reads the app's windows", async () => {
    await startApp(200, { windows: [{ app: "Figma", title: "Design" }] });
    const { client, close } = await connect();
    const result = await client.callTool({ name: "list_windows", arguments: {} });
    await close();
    expect(JSON.stringify(result.content)).toContain("Figma");
    expect(seen[0]).toMatchObject({ method: "GET", url: "/windows" });
  });
});
