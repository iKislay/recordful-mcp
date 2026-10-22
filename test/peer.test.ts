import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { PairingStore } from "../src/auth/pairings.js";
import { BridgeAgent } from "../src/bridge/BridgeAgent.js";
import { BridgeServer } from "../src/bridge/BridgeServer.js";
import { PeerClient } from "../src/bridge/PeerClient.js";
import { loadConfig } from "../src/config.js";
import { silentLogger } from "../src/logger.js";
import { ErrorCode } from "../src/protocol/errors.js";
import { BRIDGE_PATH, PEER_PATH } from "../src/protocol/messages.js";
import { connectFakeExtension, memoryPairings, TOKEN, type FakeExtension, type Handler } from "./helpers/fakeExtension.js";

let dir: string;
let store: PairingStore;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "recordful-peer-"));
  store = await PairingStore.open({ path: join(dir, "state.json"), envSecret: TOKEN });
});
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  await rm(dir, { recursive: true, force: true });
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

const startOwner = async (withPeers = true) => {
  const owner = new BridgeServer({
    port: 0,
    pairings: memoryPairings(),
    allowedExtensionIds: [],
    handshakeTimeoutMs: 1_000,
    pairingTimeoutMs: 1_000,
    heartbeatTimeoutMs: 60_000,
    logger: silentLogger,
    ...(withPeers ? { peerSecret: () => store.peerSecret() } : {}),
  });
  await owner.start();
  cleanups.push(() => owner.stop());
  return { owner, port: owner.address!.port };
};

const extension = (port: number, handlers: Record<string, Handler> = {}): FakeExtension => {
  const ext = connectFakeExtension({ port, handlers });
  cleanups.push(() => ext.close());
  return ext;
};

const rawUpgrade = (port: number, path: string, origin?: string) =>
  new Promise<number>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, origin ? { origin } : {});
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("open", () => {
      resolve(101);
      ws.close();
    });
    ws.on("error", () => {});
  });

describe("peers: a second recordful-mcp shares the first one's connection", () => {
  it("forwards state, waits and requests to the owner's extension", async () => {
    const { port } = await startOwner();
    const peer = await PeerClient.connect({ port, peerSecret: () => store.peerSecret(), logger: silentLogger });
    cleanups.push(() => peer.close());
    expect((await peer.state()).session).toBeNull();

    const waiting = peer.waitForSession(3_000);
    await extension(port, { "status.get": () => ({ state: "idle" }) }).ready;
    await expect(waiting).resolves.toMatchObject({ client: { extensionVersion: "0.0.0-test" } });
    await expect(peer.request("status.get", {}, 2_000)).resolves.toEqual({ state: "idle" });
    expect((await peer.state()).session).not.toBeNull();
  });

  it("passes the extension's errors through with their codes", async () => {
    const { port } = await startOwner();
    await extension(port, {
      "recording.stop": () => {
        throw Object.assign(new Error("No recording in progress"), { code: "NOT_RECORDING" });
      },
    }).ready;
    const peer = await PeerClient.connect({ port, peerSecret: () => store.peerSecret(), logger: silentLogger });
    cleanups.push(() => peer.close());
    await expect(peer.request("recording.stop", {}, 2_000)).rejects.toMatchObject({ code: "NOT_RECORDING" });
  });

  it("reports PAIRING_PENDING with the code to a peer that is waiting", async () => {
    const { owner, port } = await startOwner();
    const peer = await PeerClient.connect({ port, peerSecret: () => store.peerSecret(), logger: silentLogger, app: "Cursor" });
    cleanups.push(() => peer.close());
    const waiting = peer.waitForSession(5_000).catch((e: unknown) => e);
    // Let the peer's wait reach the owner before the pairing starts.
    await new Promise((r) => setTimeout(r, 100));
    const ext = connectFakeExtension({ port, token: null, pairing: "ignore" });
    cleanups.push(() => ext.close());
    const code = await ext.pairCode;
    await expect(waiting).resolves.toMatchObject({ code: ErrorCode.PairingPending, data: { code } });
    // The pairing window names the app that was asking.
    expect(owner.pairing?.app).toBe("Cursor");
  });

  it("refuses a peer with the wrong secret", async () => {
    const { port } = await startOwner();
    await expect(
      PeerClient.connect({ port, peerSecret: async () => "x".repeat(43), logger: silentLogger }),
    ).rejects.toMatchObject({ code: ErrorCode.BridgeUnavailable, message: expect.stringMatching(/different pairing file/) });
  });

  it("refuses browsers on the peer endpoint and unknown paths", async () => {
    const { port } = await startOwner();
    expect(await rawUpgrade(port, PEER_PATH, "https://evil.example")).toBe(403);
    expect(await rawUpgrade(port, "/somewhere-else")).toBe(404);
    // The extension endpoint still answers extensions only.
    expect(await rawUpgrade(port, BRIDGE_PATH, "https://evil.example")).toBe(403);
  });

  it("has no peer endpoint without a peer secret", async () => {
    const { port } = await startOwner(false);
    expect(await rawUpgrade(port, PEER_PATH)).toBe(404);
  });

  it("says NO_OWNER when nothing listens", async () => {
    const port = await freePort();
    await expect(PeerClient.connect({ port, peerSecret: () => store.peerSecret(), logger: silentLogger })).rejects.toMatchObject({
      code: "NO_OWNER",
    });
  });
});

describe("BridgeAgent", () => {
  const configFor = (port: number) =>
    loadConfig({
      RECORDFUL_BRIDGE_PORT: String(port),
      RECORDFUL_BRIDGE_ALLOWED_EXTENSION_IDS: "*",
      RECORDFUL_BRIDGE_STATE_PATH: join(dir, "state.json"),
      RECORDFUL_BRIDGE_TOKEN: TOKEN,
    });

  it("owns the port when it's free, joins when it isn't, and takes over when the owner exits", async () => {
    const port = await freePort();
    const config = configFor(port);
    const a = new BridgeAgent({ config, pairings: store, logger: silentLogger });
    const b = new BridgeAgent({ config, pairings: store, logger: silentLogger });
    cleanups.push(() => b.stop(), () => a.stop());

    await a.start();
    expect(a.connection.mode).toBe("owner");
    await b.start();
    expect(b.connection.mode).toBe("peer");

    const first = extension(port, { "status.get": () => ({ from: "first" }) });
    await first.ready;
    await expect(b.request("status.get", {}, 2_000)).resolves.toEqual({ from: "first" });

    await a.stop();
    // b notices and takes the port over.
    const deadline = Date.now() + 5_000;
    while (b.connection.mode !== "owner" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(b.connection.mode).toBe("owner");

    // The extension reconnects to whoever owns the port now.
    await extension(port, { "status.get": () => ({ from: "second" }) }).ready;
    await expect(b.request("status.get", {}, 2_000)).resolves.toEqual({ from: "second" });
  });

  it("with mayOwn false, only joins and reports NO_OWNER otherwise", async () => {
    const port = await freePort();
    const cli = new BridgeAgent({ config: configFor(port), pairings: store, logger: silentLogger, mayOwn: false });
    cleanups.push(() => cli.stop());
    await cli.start();
    expect(cli.connection.mode).toBe("none");
    expect(cli.lastErrorCode).toBe("NO_OWNER");
  });

  it("reports BRIDGE_UNAVAILABLE when the port is used by something else", async () => {
    const port = await freePort();
    // A plain HTTP server that isn't recordful-mcp.
    const { createServer: http } = await import("node:http");
    const other = http((_req, res) => res.end("hi"));
    await new Promise<void>((r) => other.listen(port, "127.0.0.1", () => r()));
    cleanups.push(() => new Promise<void>((r) => other.close(() => r())));
    const agent = new BridgeAgent({ config: configFor(port), pairings: store, logger: silentLogger });
    cleanups.push(() => agent.stop());
    await agent.start();
    expect(agent.connection.mode).toBe("none");
    await expect(agent.request("status.get", {}, 500)).rejects.toMatchObject({ code: ErrorCode.BridgeUnavailable });
  });
});
