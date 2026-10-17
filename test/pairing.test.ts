import { afterEach, describe, expect, it } from "vitest";
import { BridgeServer } from "../src/bridge/BridgeServer.js";
import { silentLogger } from "../src/logger.js";
import { ErrorCode } from "../src/protocol/errors.js";
import { CloseCode } from "../src/protocol/messages.js";
import { connectFakeExtension, EXTENSION_ID, memoryPairings, type FakeExtension } from "./helpers/fakeExtension.js";

const servers: BridgeServer[] = [];
const clients: FakeExtension[] = [];

const startBridge = async (overrides: Partial<ConstructorParameters<typeof BridgeServer>[0]> = {}) => {
  const bridge = new BridgeServer({
    port: 0,
    pairings: memoryPairings(),
    pairingTimeoutMs: 2_000,
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

describe("BridgeServer pairing", () => {
  it("announces its server id and the app asking", async () => {
    const { bridge, port } = await startBridge();
    bridge.setAppName("Claude Code");
    const client = connect({ port });
    await expect(client.challenge).resolves.toMatchObject({ app: "Claude Code" });
    await client.ready;
  });

  it("pairs an unknown extension once the user allows it, then accepts its secret", async () => {
    const pairings = memoryPairings({});
    const { bridge, port } = await startBridge({ pairings });
    const pairingSeen = new Promise((resolve) => bridge.once("pairing", resolve));
    const client = connect({ port, token: null, pairing: "accept" });
    const code = await client.pairCode;
    expect(code).toMatch(/^\d{4}$/);
    await expect(pairingSeen).resolves.toMatchObject({ code, extensionId: EXTENSION_ID });
    await client.ready;
    expect(pairings.secrets.get(EXTENSION_ID)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(bridge.pairing).toBeNull();
    expect(bridge.currentSession?.client.extensionId).toBe(EXTENSION_ID);
  });

  it("tells a waiting agent the code as soon as pairing starts", async () => {
    const { bridge, port } = await startBridge({ pairings: memoryPairings({}) });
    const waiting = bridge.waitForSession(5_000).catch((err: unknown) => err);
    const client = connect({ port, token: null, pairing: "ignore" });
    const code = await client.pairCode;
    await expect(waiting).resolves.toMatchObject({ code: ErrorCode.PairingPending, data: { code } });
    // A retry while the prompt is open waits for the user instead of failing at once.
    await expect(bridge.waitForSession(100)).rejects.toMatchObject({ code: ErrorCode.PairingPending });
  });

  it("closes and remembers the denial when the user declines", async () => {
    const pairings = memoryPairings({});
    const { bridge, port } = await startBridge({ pairings });
    const client = connect({ port, token: null, pairing: "reject" });
    expect((await client.closed).code).toBe(CloseCode.PairingRejected);
    expect(pairings.secrets.size).toBe(0);
    await expect(bridge.waitForSession(100)).rejects.toMatchObject({ code: ErrorCode.PairingDenied });
  });

  it("gives up on a prompt nobody answers", async () => {
    const { bridge, port } = await startBridge({ pairings: memoryPairings({}), pairingTimeoutMs: 100 });
    const client = connect({ port, token: null, pairing: "ignore" });
    expect((await client.closed).code).toBe(CloseCode.PairingTimeout);
    expect(bridge.pairing).toBeNull();
  });

  it("replaces an open prompt when the user asks again", async () => {
    const { bridge, port } = await startBridge({ pairings: memoryPairings({}) });
    const first = connect({ port, token: null, pairing: "ignore" });
    await first.pairCode;
    const second = connect({ port, token: null, pairing: "ignore" });
    const code = await second.pairCode;
    expect((await first.closed).code).toBe(CloseCode.PairingTimeout);
    expect(bridge.pairing?.code).toBe(code);
  });

  it("refuses pair_accept without a pairing in progress", async () => {
    const { port } = await startBridge();
    const client = connect({ port, silent: true });
    await client.challenge;
    client.ws.send(JSON.stringify({ type: "pair_accept", secret: "a".repeat(43) }));
    expect((await client.closed).code).toBe(CloseCode.BadMessage);
  });

  it("rejects a hello signed with a secret this machine never paired", async () => {
    const { port } = await startBridge({ pairings: memoryPairings({}) });
    const client = connect({ port });
    expect((await client.closed).code).toBe(CloseCode.AuthFailed);
  });
});
