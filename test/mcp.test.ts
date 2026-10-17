import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeServer } from "../src/bridge/BridgeServer.js";
import { loadConfig } from "../src/config.js";
import { silentLogger } from "../src/logger.js";
import { createMcpServer } from "../src/mcp/createMcpServer.js";
import { connectFakeExtension, TOKEN, type FakeExtension, type Handler } from "./helpers/fakeExtension.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const setup = async (handlers?: Record<string, Handler>) => {
  const config = { ...loadConfig({}), port: 0, connectWaitMs: 200 };
  const bridge = new BridgeServer({
    port: 0,
    token: TOKEN,
    allowedExtensionIds: [],
    handshakeTimeoutMs: 1_000,
    heartbeatTimeoutMs: 60_000,
    logger: silentLogger,
  });
  await bridge.start();
  cleanups.push(() => bridge.stop());

  let extension: FakeExtension | null = null;
  if (handlers) {
    extension = connectFakeExtension({ port: bridge.address!.port, handlers });
    cleanups.push(() => extension?.close());
    await extension.ready;
  }

  const server = createMcpServer({ bridge, binding: null, config, logger: silentLogger, version: "0.0.0-test" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  return { client, bridge };
};

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  JSON.parse((result.content as Array<{ text: string }>)[0]!.text);

describe("MCP tools", () => {
  it("lists the recorder and page tools with agent instructions", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "click",
      "get_status",
      "navigate",
      "pause_recording",
      "press",
      "probe_capture",
      "resume_recording",
      "screenshot",
      "scroll",
      "snapshot",
      "start_recording",
      "stop_recording",
      "type",
      "wait_for",
    ]);
    const instructions = client.getInstructions() ?? "";
    // The order agents must follow: plan, hand over the tab, start, act, pause, stop.
    const order = ["Plan", "Recordful toolbar icon", "start_recording", "click(ref)", "pause_recording", "stop_recording"];
    const positions = order.map((needle) => instructions.indexOf(needle));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("get_status works without an extension", async () => {
    const { client } = await setup();
    const out = textOf(await client.callTool({ name: "get_status", arguments: {} }));
    expect(out.bridge.extensionConnected).toBe(false);
    expect(out.recorder).toBeNull();
  });

  it("recording tools fail with NOT_CONNECTED and a hint when the extension is absent", async () => {
    const { client } = await setup();
    const result = await client.callTool({ name: "start_recording", arguments: {} });
    expect(result.isError).toBe(true);
    const out = textOf(result);
    expect(out.error.code).toBe("NOT_CONNECTED");
    expect(out.error.data.hint).toBeTruthy();
  });

  it("forwards start_recording to recording.start with the wait budget", async () => {
    const seen: Record<string, unknown>[] = [];
    const { client } = await setup({
      "recording.start": (params) => {
        seen.push(params);
        return { outcome: "recording", recordingType: "tab" };
      },
    });
    const result = await client.callTool({ name: "start_recording", arguments: { tabId: 12, timeoutMs: 5_000 } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toEqual({ outcome: "recording", recordingType: "tab" });
    expect(seen).toEqual([{ tabId: 12, timeoutMs: 5_000 }]);
  });

  it("maps extension errors to isError results", async () => {
    const { client } = await setup({
      "recording.stop": () => {
        throw Object.assign(new Error("No recording in progress"), { code: "NOT_RECORDING" });
      },
    });
    const result = await client.callTool({ name: "stop_recording", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result).error).toMatchObject({ code: "NOT_RECORDING" });
  });

  it("rejects out-of-range input before it reaches the extension", async () => {
    const calls: unknown[] = [];
    const { client } = await setup({ "recording.start": (p) => calls.push(p) });
    const result = await client.callTool({ name: "start_recording", arguments: { timeoutMs: 5 } });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("get_status merges bridge and recorder state", async () => {
    const { client } = await setup({ "status.get": () => ({ state: "idle", recordingType: "tab" }) });
    const out = textOf(await client.callTool({ name: "get_status", arguments: {} }));
    expect(out.bridge.extensionConnected).toBe(true);
    expect(out.recorder).toEqual({ state: "idle", recordingType: "tab" });
  });
});

describe("MCP page tools", () => {
  const recording = () => {
    const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
    const record =
      (method: string, result: unknown = { ok: true }): Handler =>
      (params) => {
        seen.push({ method, params });
        return result;
      };
    return { seen, record };
  };

  it("forwards each page tool to its page.* method with validated params", async () => {
    const { seen, record } = recording();
    const { client } = await setup({
      "page.navigate": record("page.navigate", { url: "https://example.com/", title: "Example" }),
      "page.snapshot": record("page.snapshot", { elements: [{ ref: "e1", role: "link", name: "More" }] }),
      "page.click": record("page.click"),
      "page.type": record("page.type"),
      "page.press": record("page.press"),
      "page.scroll": record("page.scroll"),
      "page.waitFor": record("page.waitFor"),
    });
    const calls: Array<[string, Record<string, unknown>]> = [
      ["navigate", { url: "https://example.com" }],
      ["snapshot", { scope: "viewport" }],
      ["click", { ref: "e1" }],
      ["type", { ref: "e2", text: "hello", clear: true }],
      ["press", { key: "Shift+Tab" }],
      ["scroll", { direction: "down", amount: 400 }],
      ["wait_for", { text: "Welcome", timeoutMs: 2_000 }],
    ];
    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, name).toBeFalsy();
    }
    expect(seen).toEqual([
      { method: "page.navigate", params: { url: "https://example.com" } },
      { method: "page.snapshot", params: { scope: "viewport" } },
      { method: "page.click", params: { ref: "e1" } },
      { method: "page.type", params: { ref: "e2", text: "hello", clear: true } },
      { method: "page.press", params: { key: "Shift+Tab" } },
      { method: "page.scroll", params: { direction: "down", amount: 400 } },
      { method: "page.waitFor", params: { text: "Welcome", timeoutMs: 2_000 } },
    ]);
  });

  it.each([
    ["navigate", { url: "javascript:alert(1)" }],
    ["navigate", { url: "file:///etc/passwd" }],
    ["navigate", { url: "/relative" }],
    ["click", { ref: "button" }],
    ["click", {}],
    ["type", { ref: "e1", text: "x".repeat(2_001) }],
    ["type", { ref: "e1", text: "hi", delayMs: 1_000 }],
    ["press", { key: "Enter Enter" }],
    ["press", { key: "Hyper+a" }],
    ["scroll", {}],
    ["scroll", { ref: "e1", direction: "down" }],
    ["scroll", { ref: "e1", amount: 50 }],
    ["wait_for", {}],
    ["wait_for", { text: "a", ref: "e1" }],
    ["wait_for", { text: "a", timeoutMs: 120_000 }],
  ])("rejects %s %j before it reaches the extension", async (name, args) => {
    const calls: unknown[] = [];
    const any: Handler = (p) => calls.push(p);
    const { client } = await setup({
      "page.navigate": any,
      "page.click": any,
      "page.type": any,
      "page.press": any,
      "page.scroll": any,
      "page.waitFor": any,
    });
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("returns screenshots as MCP image content", async () => {
    const { client } = await setup({
      "page.screenshot": () => ({ mimeType: "image/jpeg", data: "aGVsbG8=", width: 1280, height: 800 }),
    });
    const result = await client.callTool({ name: "screenshot", arguments: {} });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" });
    expect(JSON.parse(content[1]!.text as string)).toEqual({ width: 1280, height: 800 });
  });

  it("passes page errors through with their codes", async () => {
    const { client } = await setup({
      "page.click": () => {
        throw Object.assign(new Error("Take a new snapshot"), { code: "STALE_REF" });
      },
    });
    const result = await client.callTool({ name: "click", arguments: { ref: "e9" } });
    expect(result.isError).toBe(true);
    expect(textOf(result).error).toMatchObject({ code: "STALE_REF" });
  });

  it("tells the agent to rebuild an extension that predates page tools", async () => {
    // The fake extension answers UNKNOWN_METHOD for anything it has no handler for.
    const { client } = await setup({ "status.get": () => ({ state: "idle" }) });
    const result = await client.callTool({ name: "snapshot", arguments: {} });
    expect(result.isError).toBe(true);
    const { error } = textOf(result);
    expect(error.code).toBe("UNKNOWN_METHOD");
    expect(error.data.hint).toMatch(/build:agent/);
  });
});
