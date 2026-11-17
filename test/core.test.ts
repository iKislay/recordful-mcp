import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  // recordful.app/mcp behind cloud.mcp; without it, an extension that predates cloud.mcp.
  hosted?: (message: { id?: number; method: string; params?: Record<string, unknown> }) => unknown;
}) => {
  const sent: Sent[] = [];
  let readyWaits: number[] = [];
  const transport: RecorderTransport = {
    ready: async (timeoutMs) => {
      readyWaits.push(timeoutMs);
      if (!opts.connected) throw new BridgeError(ErrorCode.NotConnected, "relay: no extension", { hint: "sign in" });
    },
    request: async (method, params, timeoutMs) => {
      if (method === "cloud.mcp") {
        if (!opts.hosted) throw new BridgeError(ErrorCode.UnknownMethod, method);
        return opts.hosted(params.message as never);
      }
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
      motionGuide: (ask) => `Hosted motion guide for ${ask ?? "?"}`,
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
    // Each call waits as configured (so does listing the hosted tools).
    expect(new Set(fake.readyWaits())).toEqual(new Set([1_234]));
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

// ---- the hosted tools, by proxy (hostedTools.ts) -----------------------------

const TIMELINE = {
  name: "get_timeline",
  title: "Read how a video is edited",
  description: "Recordful Pro only. The edit of a video.",
  inputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { videoId: { type: "string", format: "uuid", description: "The video's id." } },
    required: ["videoId"],
    additionalProperties: false,
  },
  outputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { version: { type: "number" } },
    required: ["version"],
  },
  annotations: { readOnlyHint: true, title: "Read how a video is edited" },
};
const HOSTED_GET_VIDEO = { name: "get_video", description: "Hosted get_video.", inputSchema: { type: "object" } };

const fakeHosted = (answer: (name: string, args: unknown) => unknown) => {
  const calls: Array<Record<string, unknown>> = [];
  const hosted = ({ id, method, params }: { id?: number; method: string; params?: Record<string, unknown> }) => {
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    if (method === "initialize") {
      return reply({ protocolVersion: params!.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "Recordful", version: "1.0.0" } });
    }
    if (method === "tools/list") return reply({ tools: [TIMELINE, HOSTED_GET_VIDEO] });
    if (method === "tools/call") {
      calls.push(params!);
      return reply(answer(params!.name as string, params!.arguments));
    }
    return null; // notifications/initialized
  };
  return { hosted, calls };
};

const toolNamed = async (client: Client, name: string) =>
  vi.waitFor(async () => {
    const tool = (await client.listTools()).tools.find((t) => t.name === name);
    if (!tool) throw new Error(`${name} not listed yet`);
    return tool;
  });

describe("hosted tools by proxy", () => {
  const VIDEO = "0b0b8f6e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

  it("lists each hosted tool as the hosted server describes it; a local tool wins a clash", async () => {
    const { hosted } = fakeHosted(() => ({}));
    const client = await setup(fakeTransport({ connected: true, hosted }).transport);
    const timeline = await toolNamed(client, "get_timeline");
    expect(timeline).toMatchObject({
      title: TIMELINE.title,
      description: TIMELINE.description,
      inputSchema: TIMELINE.inputSchema,
      outputSchema: TIMELINE.outputSchema,
      annotations: TIMELINE.annotations,
    });
    const getVideo = (await client.listTools()).tools.filter((t) => t.name === "get_video");
    expect(getVideo).toHaveLength(1);
    expect(getVideo[0]!.description).not.toBe(HOSTED_GET_VIDEO.description);
  });

  it("forwards a call and returns the hosted result untouched, errors included", async () => {
    const ok = { content: [{ type: "text", text: '{"version":3}' }], structuredContent: { version: 3 } };
    const forbidden = {
      content: [{ type: "text", text: '{"error":"forbidden","message":"This needs Recordful Pro."}' }],
      isError: true,
      _meta: { "app.recordful/error": { errorCode: "forbidden", retryable: false } },
    };
    let pro = true;
    const { hosted, calls } = fakeHosted(() => (pro ? ok : forbidden));
    const client = await setup(fakeTransport({ connected: true, hosted }).transport);
    await toolNamed(client, "get_timeline");

    const args = { videoId: VIDEO };
    expect(await client.callTool({ name: "get_timeline", arguments: args, _meta: { "app.recordful/idempotency-key": "k1" } })).toEqual(ok);
    expect(calls[0]).toMatchObject({ name: "get_timeline", arguments: args, _meta: { "app.recordful/idempotency-key": "k1" } });

    pro = false;
    expect(await client.callTool({ name: "get_timeline", arguments: args })).toEqual(forbidden);
  });

  it("leaves the hosted tools out while the extension can't reach recordful.app", async () => {
    const client = await setup(fakeTransport({ connected: true }).transport);
    await client.callTool({ name: "get_status", arguments: {} });
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("get_timeline");
  });
});
