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
  it("lists the recorder tools with agent instructions", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_status",
      "pause_recording",
      "probe_capture",
      "resume_recording",
      "start_recording",
      "stop_recording",
    ]);
    expect(client.getInstructions()).toMatch(/start_recording/);
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
