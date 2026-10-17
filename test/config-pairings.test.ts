import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeProof, verifyProof } from "../src/auth/handshake.js";
import { MIN_STATIC_SECRET_LENGTH, PairingStore } from "../src/auth/pairings.js";
import { appDisplayName } from "../src/clientNames.js";
import { loadConfig, OFFICIAL_EXTENSION_ID } from "../src/config.js";
import { DEFAULT_PORT } from "../src/protocol/messages.js";

const DEV_ID = "abcdefghijklmnopabcdefghijklmnop";
const SECRET = "A".repeat(43);

describe("loadConfig", () => {
  it("allows only the Chrome Web Store build by default", () => {
    const config = loadConfig({});
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.allowedExtensionIds).toEqual([OFFICIAL_EXTENSION_ID]);
  });

  it("adds extra extension IDs, and * allows any", () => {
    expect(
      loadConfig({ RECORDFUL_BRIDGE_ALLOWED_EXTENSION_IDS: ` ${DEV_ID} ,` }).allowedExtensionIds,
    ).toEqual([OFFICIAL_EXTENSION_ID, DEV_ID]);
    expect(loadConfig({ RECORDFUL_BRIDGE_ALLOWED_EXTENSION_IDS: "*" }).allowedExtensionIds).toEqual([]);
    expect(() => loadConfig({ RECORDFUL_BRIDGE_ALLOWED_EXTENSION_IDS: "nope" })).toThrow(
      /not a Chrome extension ID/,
    );
  });

  it("rejects bad ports", () => {
    expect(() => loadConfig({ RECORDFUL_BRIDGE_PORT: "abc" })).toThrow();
    expect(() => loadConfig({ RECORDFUL_BRIDGE_PORT: "70000" })).toThrow();
  });
});

describe("PairingStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "recordful-pairings-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates one server identity and keeps it", async () => {
    const path = join(dir, "nested", "agent-bridge.json");
    const first = await PairingStore.open({ path });
    const second = await PairingStore.open({ path });
    expect(second.serverId).toBe(first.serverId);
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(2);
  });

  it("saves, lists and forgets pairings, visible to other processes", async () => {
    const path = join(dir, "s.json");
    const a = await PairingStore.open({ path });
    const b = await PairingStore.open({ path });
    await a.save(DEV_ID, SECRET, "Claude Code");
    expect(await b.secretsFor(DEV_ID)).toEqual([SECRET]);
    expect(await b.list()).toMatchObject([{ extensionId: DEV_ID, app: "Claude Code" }]);
    expect(await b.remove(DEV_ID)).toBe(1);
    expect(await a.secretsFor(DEV_ID)).toEqual([]);
  });

  it("refuses malformed secrets", async () => {
    const store = await PairingStore.open({ path: join(dir, "s.json") });
    await expect(store.save(DEV_ID, "short", "x")).rejects.toThrow();
  });

  it("accepts an env secret for every extension and enforces its length", async () => {
    const path = join(dir, "s.json");
    const envSecret = "x".repeat(MIN_STATIC_SECRET_LENGTH);
    const store = await PairingStore.open({ path, envSecret });
    expect(await store.secretsFor(DEV_ID)).toEqual([envSecret]);
    await expect(PairingStore.open({ path, envSecret: "short" })).rejects.toThrow(/at least/);
  });

  it("migrates a v0.1 token file, keeping the token usable", async () => {
    const path = join(dir, "s.json");
    const token = "t".repeat(43);
    await writeFile(path, JSON.stringify({ version: 1, token, createdAt: "2026-10-17T00:00:00Z" }));
    const store = await PairingStore.open({ path });
    expect(await store.secretsFor(DEV_ID)).toEqual([token]);
    const onDisk = JSON.parse(await readFile(path, "utf8"));
    expect(onDisk).toMatchObject({ version: 2, legacyToken: token, serverId: store.serverId });
  });

  it("refuses a corrupt file instead of silently starting over", async () => {
    const path = join(dir, "s.json");
    await writeFile(path, "{not json");
    await expect(PairingStore.open({ path })).rejects.toThrow(/not valid JSON/);
  });
});

describe("appDisplayName", () => {
  it("prefers the client's title, then known names, then a tidied name", () => {
    expect(appDisplayName({ name: "x", title: "My Agent" })).toBe("My Agent");
    expect(appDisplayName({ name: "claude-code" })).toBe("Claude Code");
    expect(appDisplayName({ name: "opencode" })).toBe("opencode");
    expect(appDisplayName({ name: "acme-agent-mcp-client" })).toBe("Acme Agent");
  });
});

describe("handshake proofs", () => {
  const s = "a".repeat(64);
  const c = "b".repeat(64);

  it("binds role, both nonces and the secret", () => {
    const proof = computeProof("secret", "client", s, c);
    expect(verifyProof(proof, computeProof("secret", "client", s, c))).toBe(true);
    expect(verifyProof(proof, computeProof("secret", "server", s, c))).toBe(false);
    expect(verifyProof(proof, computeProof("secret", "client", c, s))).toBe(false);
    expect(verifyProof(proof, computeProof("other", "client", s, c))).toBe(false);
  });

  it("rejects malformed proofs without throwing", () => {
    expect(verifyProof(computeProof("t", "client", s, c), "zz")).toBe(false);
    expect(verifyProof(computeProof("t", "client", s, c), "")).toBe(false);
  });
});
