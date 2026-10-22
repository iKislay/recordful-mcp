import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createRecordfulServer } from "../src/core/createRecordfulServer.js";
import type { RecorderTransport, TransportStatus } from "../src/core/transport.js";
import { silentLogger } from "../src/logger.js";
import { BridgeError, ErrorCode } from "../src/protocol/errors.js";

// The core must run outside Node (the hosted server is a Cloudflare Worker).
// These are the modules it is built from; nothing in them may reach for Node.
const ROOT = join(import.meta.dirname, "..");
const CORE_FILES = [
  ...readdirSync(join(ROOT, "src/core")).map((f) => `src/core/${f}`),
  ...readdirSync(join(ROOT, "src/protocol")).map((f) => `src/protocol/${f}`),
  "src/workflows.ts",
].filter((f) => f.endsWith(".ts"));

describe("core stays runtime-agnostic", () => {
  it.each(CORE_FILES)("%s uses no Node APIs", (file) => {
    const source = readFileSync(join(ROOT, file), "utf8");
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/\bprocess\./);
    expect(source).not.toMatch(/\bBuffer\b/);
    expect(source).not.toMatch(/\bNodeJS\./);
  });

  it.each(CORE_FILES)("%s only imports core modules at runtime", (file) => {
    const source = readFileSync(join(ROOT, file), "utf8");
    // `import type` is erased, so it may point anywhere (the Logger type).
    const runtime = [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+["'](\.[^"']+)["']/gm)].map((m) => m[1]!);
    for (const spec of runtime) {
      const target = relative(ROOT, join(ROOT, file, "..", spec)).replaceAll("\\", "/").replace(/\.js$/, ".ts");
      expect(CORE_FILES, `${file} imports ${spec}`).toContain(target);
    }
  });
});

// ---- the core over a fake transport ----------------------------------------

interface Sent {
  method: string;
  params: Record<string, unknown>;
  timeoutMs: number;
}

const fakeTransport = (opts: {
  connected?: boolean;
  answer?: (method: string, params: Record<string, unknown>) => unknown;
}) => {
  const sent: Sent[] = [];
  let readyWaits: number[] = [];
  const transport: RecorderTransport = {
    ready: async (timeoutMs) => {
      readyWaits.push(timeoutMs);
      if (!opts.connected) throw new BridgeError(ErrorCode.NotConnected, "relay: no extension", { hint: "sign in" });
    },
    request: async (method, params, timeoutMs) => {
      sent.push({ method, params, timeoutMs });
      return opts.answer ? opts.answer(method, params) : { ok: true };
    },
    status: async (): Promise<TransportStatus> => ({
      connected: opts.connected ?? false,
      detail: { relay: "fake", extensionConnected: opts.connected ?? false },
      hint: "Turn on Allow cloud AI apps.",
    }),
  };
  return { transport, sent, readyWaits: () => readyWaits };
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const setup = async (transport: RecorderTransport) => {
  const server = createRecordfulServer({
    transport,
    copy: {
      instructions: "Hosted instructions.",
      recordFeaturePrompt: (feature, url) => `Hosted prompt for ${feature} at ${url ?? "?"}`,
    },
    timeouts: { connectWaitMs: 1_234, requestTimeoutMs: 10_000 },
    logger: silentLogger,
    version: "0.0.0-test",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  return client;
};

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  JSON.parse((result.content as Array<{ text: string }>)[0]!.text);

describe("core over another transport", () => {
  it("uses the transport's copy for instructions and the prompt", async () => {
    const client = await setup(fakeTransport({}).transport);
    expect(client.getInstructions()).toBe("Hosted instructions.");
    const prompt = await client.getPrompt({ name: "record_feature", arguments: { feature: "billing", url: "https://x.dev" } });
    expect((prompt.messages[0]!.content as { text: string }).text).toBe("Hosted prompt for billing at https://x.dev");
  });

  it("get_status shows the transport's status and hint when nothing is attached", async () => {
    const fake = fakeTransport({ connected: false });
    const client = await setup(fake.transport);
    const status = textOf(await client.callTool({ name: "get_status", arguments: {} }));
    expect(status).toEqual({
      bridge: { relay: "fake", extensionConnected: false },
      recorder: null,
      hint: "Turn on Allow cloud AI apps.",
    });
    expect(fake.sent).toEqual([]);
  });

  it("get_status asks the extension when attached", async () => {
    const fake = fakeTransport({ connected: true, answer: () => ({ state: "idle" }) });
    const client = await setup(fake.transport);
    const status = textOf(await client.callTool({ name: "get_status", arguments: {} }));
    expect(status.recorder).toEqual({ state: "idle" });
    expect(fake.sent.map((s) => s.method)).toEqual(["status.get"]);
  });

  it("forwards tool calls with the configured timeouts", async () => {
    const fake = fakeTransport({ connected: true });
    const client = await setup(fake.transport);
    await client.callTool({ name: "navigate", arguments: { url: "https://example.com" } });
    await client.callTool({ name: "pause_recording", arguments: {} });
    expect(fake.readyWaits()).toEqual([1_234, 1_234]);
    expect(fake.sent[0]).toMatchObject({ method: "page.navigate", params: { url: "https://example.com" } });
    expect(fake.sent[0]!.timeoutMs).toBeGreaterThan(10_000);
    expect(fake.sent[1]).toEqual({ method: "recording.pause", params: {}, timeoutMs: 20_000 });
  });

  it("reports the transport's errors as tool errors", async () => {
    const client = await setup(fakeTransport({ connected: false }).transport);
    const result = await client.callTool({ name: "snapshot", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toEqual({ error: { code: "NOT_CONNECTED", message: "relay: no extension", data: { hint: "sign in" } } });
  });
});
