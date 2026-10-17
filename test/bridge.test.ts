import { afterEach, describe, expect, it } from "vitest";
import { BridgeServer, originToExtensionId } from "../src/bridge/BridgeServer.js";
import { silentLogger } from "../src/logger.js";
import { BridgeError, ErrorCode } from "../src/protocol/errors.js";
import { CloseCode, MAX_MESSAGE_BYTES } from "../src/protocol/messages.js";
import { pageExtraWaitMs, parsePageParams } from "../src/protocol/page.js";
import { connectFakeExtension, EXTENSION_ID, TOKEN, type FakeExtension } from "./helpers/fakeExtension.js";

const servers: BridgeServer[] = [];
const clients: FakeExtension[] = [];

const startBridge = async (overrides: Partial<ConstructorParameters<typeof BridgeServer>[0]> = {}) => {
  const bridge = new BridgeServer({
    port: 0,
    token: TOKEN,
    allowedExtensionIds: [],
    handshakeTimeoutMs: 1_000,
    heartbeatTimeoutMs: 60_000,
    logger: silentLogger,
    ...overrides,
  });
  await bridge.start();
  servers.push(bridge);
  return { bridge, port: bridge.address!.port };
};

const connect = (opts: Parameters<typeof connectFakeExtension>[0]) => {
  const client = connectFakeExtension(opts);
  clients.push(client);
  return client;
};

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

describe("originToExtensionId", () => {
  it("accepts only bare chrome-extension origins", () => {
    expect(originToExtensionId(`chrome-extension://${EXTENSION_ID}`)).toBe(EXTENSION_ID);
    expect(originToExtensionId("https://example.com")).toBeNull();
    expect(originToExtensionId(`chrome-extension://${EXTENSION_ID}/x`)).toBeNull();
    expect(originToExtensionId("chrome-extension://short")).toBeNull();
    expect(originToExtensionId(undefined)).toBeNull();
  });
});

describe("BridgeServer handshake", () => {
  it("authenticates both directions with a shared token", async () => {
    const { bridge, port } = await startBridge();
    const client = connect({ port });
    const sessionId = await client.ready;
    expect(client.serverProofValid()).toBe(true);
    expect(bridge.currentSession?.sessionId).toBe(sessionId);
    expect(bridge.currentSession?.client.extensionId).toBe(EXTENSION_ID);
  });

  it("rejects web origins before the upgrade", async () => {
    const { bridge, port } = await startBridge();
    const client = connect({ port, origin: "https://evil.example" });
    await expect(client.ready).rejects.toThrow("http 403");
    expect(bridge.currentSession).toBeNull();
  });

  it("enforces the extension ID allowlist", async () => {
    const { port } = await startBridge({ allowedExtensionIds: ["pppppppppppppppppppppppppppppppp"] });
    await expect(connect({ port }).ready).rejects.toThrow("http 403");
  });

  it("closes with AuthFailed on a wrong token", async () => {
    const { bridge, port } = await startBridge();
    const client = connect({ port, token: "wrong-token-wrong-token-wrong-token" });
    expect((await client.closed).code).toBe(CloseCode.AuthFailed);
    expect(bridge.currentSession).toBeNull();
  });

  it("rejects a hello whose extension ID doesn't match its origin", async () => {
    const { port } = await startBridge();
    const client = connect({ port, extensionId: "pppppppppppppppppppppppppppppppp", origin: `chrome-extension://${EXTENSION_ID}` });
    expect((await client.closed).code).toBe(CloseCode.AuthFailed);
  });

  it("closes on protocol version mismatch", async () => {
    const { port } = await startBridge();
    const client = connect({ port, protocolVersion: 999 });
    expect((await client.closed).code).toBe(CloseCode.ProtocolVersion);
  });

  it("times out a client that never says hello", async () => {
    const { port } = await startBridge({ handshakeTimeoutMs: 100 });
    const client = connect({ port, silent: true });
    expect((await client.closed).code).toBe(CloseCode.HandshakeTimeout);
  });

  it("supersedes the previous session when a new one authenticates", async () => {
    const { bridge, port } = await startBridge();
    const first = connect({ port });
    await first.ready;
    const second = connect({ port });
    const secondId = await second.ready;
    expect((await first.closed).code).toBe(CloseCode.Superseded);
    expect(bridge.currentSession?.sessionId).toBe(secondId);
  });

  it("reports a busy port as BRIDGE_UNAVAILABLE", async () => {
    const { port } = await startBridge();
    const second = new BridgeServer({
      port,
      token: TOKEN,
      allowedExtensionIds: [],
      handshakeTimeoutMs: 1_000,
      heartbeatTimeoutMs: 60_000,
      logger: silentLogger,
    });
    await expect(second.start()).rejects.toMatchObject({ code: ErrorCode.BridgeUnavailable });
  });
});

describe("BridgeServer requests", () => {
  it("round-trips a request", async () => {
    const { bridge, port } = await startBridge();
    await connect({ port, handlers: { "status.get": () => ({ state: "idle" }) } }).ready;
    await expect(bridge.request("status.get", {}, 1_000)).resolves.toEqual({ state: "idle" });
  });

  it("passes params through", async () => {
    const { bridge, port } = await startBridge();
    await connect({ port, handlers: { "recording.start": (p) => ({ echoed: p }) } }).ready;
    await expect(bridge.request("recording.start", { tabId: 7 }, 1_000)).resolves.toEqual({
      echoed: { tabId: 7 },
    });
  });

  it("surfaces extension errors as BridgeError with the same code", async () => {
    const { bridge, port } = await startBridge();
    await connect({
      port,
      handlers: {
        "recording.stop": () => {
          throw Object.assign(new Error("nothing to stop"), { code: "NOT_RECORDING" });
        },
      },
    }).ready;
    const err = await bridge.request("recording.stop", {}, 1_000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeError);
    expect(err).toMatchObject({ code: "NOT_RECORDING", message: "nothing to stop" });
  });

  it("times out a request the extension never answers", async () => {
    const { bridge, port } = await startBridge();
    await connect({ port, handlers: { "status.get": () => new Promise(() => {}) } }).ready;
    await expect(bridge.request("status.get", {}, 100)).rejects.toMatchObject({ code: ErrorCode.Timeout });
  });

  it("rejects in-flight requests when the extension disconnects", async () => {
    const { bridge, port } = await startBridge();
    const client = connect({ port, handlers: { "status.get": () => new Promise(() => {}) } });
    await client.ready;
    const pending = bridge.request("status.get", {}, 5_000);
    client.close();
    await expect(pending).rejects.toMatchObject({ code: ErrorCode.Disconnected });
  });

  it("refuses to send with no session", async () => {
    const { bridge } = await startBridge();
    await expect(bridge.request("status.get", {}, 1_000)).rejects.toMatchObject({ code: ErrorCode.NotConnected });
  });

  it("waitForSession resolves on connect and rejects after its timeout", async () => {
    const { bridge, port } = await startBridge();
    await expect(bridge.waitForSession(50)).rejects.toMatchObject({ code: ErrorCode.NotConnected });
    const waiting = bridge.waitForSession(2_000);
    connect({ port });
    await expect(waiting).resolves.toMatchObject({ client: { extensionId: EXTENSION_ID } });
  });

  it("answers pings and drops a silent session after the heartbeat timeout", async () => {
    const { bridge, port } = await startBridge({ heartbeatTimeoutMs: 50 });
    const client = connect({ port });
    await client.ready;
    const pong = new Promise((resolve) =>
      client.ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "pong") resolve(msg.ts);
      }),
    );
    client.ws.send(JSON.stringify({ type: "ping", ts: 42 }));
    await expect(pong).resolves.toBe(42);
    // The check runs every 5s; the session has been silent well past 50ms by then.
    expect((await client.closed).code).toBe(CloseCode.HeartbeatTimeout);
    expect(bridge.currentSession).toBeNull();
  });
});

describe("page methods", () => {
  it("round-trip through the extension with params intact", async () => {
    const { bridge, port } = await startBridge();
    const seen: unknown[] = [];
    await connect({
      port,
      handlers: {
        "page.click": (p) => {
          seen.push(p);
          return { clicked: "e3", at: { x: 10, y: 20 } };
        },
      },
    }).ready;
    const params = parsePageParams("page.click", { ref: "e3" });
    await expect(bridge.request("page.click", params, 1_000)).resolves.toEqual({
      clicked: "e3",
      at: { x: 10, y: 20 },
    });
    expect(seen).toEqual([{ ref: "e3" }]);
  });

  it("accepts a screenshot-sized response under the message cap", async () => {
    const { bridge, port } = await startBridge();
    // A downscaled JPEG is a few hundred KB of base64; the cap leaves headroom.
    const data = "A".repeat(700 * 1024);
    await connect({ port, handlers: { "page.screenshot": () => ({ mimeType: "image/jpeg", data }) } }).ready;
    const shot = (await bridge.request("page.screenshot", {}, 2_000)) as { data: string };
    expect(shot.data.length).toBe(data.length);
    expect(data.length).toBeLessThan(MAX_MESSAGE_BYTES);
  });

  it("validates params strictly and drops undefined fields", () => {
    expect(parsePageParams("page.type", { ref: "e1", text: "hi", clear: undefined })).toEqual({ ref: "e1", text: "hi" });
    expect(() => parsePageParams("page.click", { ref: "e1", extra: true })).toThrow(BridgeError);
    expect(() => parsePageParams("page.navigate", { url: "chrome://settings" })).toThrow(/http/);
    expect(parsePageParams("page.press", { key: "Control+Shift+ArrowLeft" })).toEqual({ key: "Control+Shift+ArrowLeft" });
    expect(parsePageParams("page.press", { key: "+" })).toEqual({ key: "+" });
    expect(() => parsePageParams("page.scroll", {})).toThrow(/exactly one/);
    expect(() => parsePageParams("page.waitFor", { text: "x", ref: "e2" })).toThrow(/exactly one/);
  });

  it("budgets time for human-paced typing and waits", () => {
    expect(pageExtraWaitMs("page.type", { text: "x".repeat(100), delayMs: 100 })).toBeGreaterThan(100 * 200);
    expect(pageExtraWaitMs("page.waitFor", { timeoutMs: 30_000 })).toBe(30_000);
    expect(pageExtraWaitMs("page.snapshot", {})).toBe(0);
  });
});
