import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeProof, verifyProof } from "../src/auth/handshake.js";
import { loadOrCreateToken, MIN_TOKEN_LENGTH } from "../src/auth/token.js";
import { loadConfig } from "../src/config.js";
import { DEFAULT_PORT } from "../src/protocol/messages.js";

describe("loadConfig", () => {
  it("has safe defaults", () => {
    const config = loadConfig({});
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.allowedExtensionIds).toEqual([]);
  });

  it("parses the allowlist and rejects malformed IDs", () => {
    const id = "abcdefghijklmnopabcdefghijklmnop";
    expect(loadConfig({ RECORDFUL_BRIDGE_ALLOWED_EXTENSION_IDS: ` ${id} ,` }).allowedExtensionIds).toEqual([id]);
    expect(() => loadConfig({ RECORDFUL_BRIDGE_ALLOWED_EXTENSION_IDS: "nope" })).toThrow(/not a Chrome extension ID/);
  });

  it("rejects bad ports", () => {
    expect(() => loadConfig({ RECORDFUL_BRIDGE_PORT: "abc" })).toThrow();
    expect(() => loadConfig({ RECORDFUL_BRIDGE_PORT: "70000" })).toThrow();
  });
});

describe("loadOrCreateToken", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "recordful-token-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a token once and reuses it", async () => {
    const path = join(dir, "nested", "agent-bridge.json");
    const first = await loadOrCreateToken({ path });
    expect(first.source).toBe("generated");
    expect(first.token.length).toBeGreaterThanOrEqual(MIN_TOKEN_LENGTH);
    const second = await loadOrCreateToken({ path });
    expect(second).toMatchObject({ source: "file", token: first.token });
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
  });

  it("rotates on request", async () => {
    const path = join(dir, "t.json");
    const first = await loadOrCreateToken({ path });
    const rotated = await loadOrCreateToken({ path, rotate: true });
    expect(rotated.token).not.toBe(first.token);
  });

  it("prefers the env token and enforces its length", async () => {
    const path = join(dir, "t.json");
    const envToken = "x".repeat(MIN_TOKEN_LENGTH);
    await expect(loadOrCreateToken({ path, envToken })).resolves.toMatchObject({ source: "env", token: envToken });
    await expect(loadOrCreateToken({ path, envToken: "short" })).rejects.toThrow(/at least/);
  });

  it("refuses a corrupt token file instead of silently re-pairing", async () => {
    const path = join(dir, "t.json");
    await writeFile(path, "{not json");
    await expect(loadOrCreateToken({ path })).rejects.toThrow(/malformed/);
  });
});

describe("handshake proofs", () => {
  const s = "a".repeat(64);
  const c = "b".repeat(64);

  it("binds role, both nonces and the token", () => {
    const proof = computeProof("token", "client", s, c);
    expect(verifyProof(proof, computeProof("token", "client", s, c))).toBe(true);
    expect(verifyProof(proof, computeProof("token", "server", s, c))).toBe(false);
    expect(verifyProof(proof, computeProof("token", "client", c, s))).toBe(false);
    expect(verifyProof(proof, computeProof("other", "client", s, c))).toBe(false);
  });

  it("rejects malformed proofs without throwing", () => {
    expect(verifyProof(computeProof("t", "client", s, c), "zz")).toBe(false);
    expect(verifyProof(computeProof("t", "client", s, c), "")).toBe(false);
  });
});
