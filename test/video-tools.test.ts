import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { BridgeServer } from "../src/bridge/BridgeServer.js";
import { loadConfig } from "../src/config.js";
import { silentLogger } from "../src/logger.js";
import { createMcpServer } from "../src/mcp/createMcpServer.js";
import { POLL } from "../src/workflows.js";
import { connectFakeExtension, memoryPairings, type Handler } from "./helpers/fakeExtension.js";

const VIDEO = "0b0b8f6e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const LINKS = { viewUrl: `https://recordful.app/view/${VIDEO}`, editUrl: `https://recordful.app/editor/${VIDEO}/edit` };

beforeAll(() => {
  POLL.videoMs = 10;
  POLL.transcriptMs = 10;
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const setup = async (handlers: Record<string, Handler>) => {
  const config = { ...loadConfig({}), connectWaitMs: 500 };
  const bridge = new BridgeServer({
    port: 0,
    pairings: memoryPairings(),
    allowedExtensionIds: [],
    handshakeTimeoutMs: 1_000,
    pairingTimeoutMs: 1_000,
    heartbeatTimeoutMs: 60_000,
    logger: silentLogger,
  });
  await bridge.start();
  cleanups.push(() => bridge.stop());
  const ext = connectFakeExtension({ port: bridge.address!.port, handlers });
  cleanups.push(() => ext.close());
  await ext.ready;
  const server = createMcpServer({ bridge, config, logger: silentLogger, version: "0.0.0-test" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  cleanups.push(() => client.close());
  return client;
};

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  JSON.parse((result.content as Array<{ text: string }>)[0]!.text);

// A video whose stages follow `stages`, one per look, then stay on the last.
const stagedVideo = (stages: Array<Record<string, unknown>>) => {
  let i = 0;
  return () => ({ videoId: VIDEO, ...LINKS, ...stages[Math.min(i++, stages.length - 1)] });
};

describe("upload_recording", () => {
  it("starts the upload and waits until it's up, reporting progress", async () => {
    const seen: Record<string, unknown>[] = [];
    const client = await setup({
      "video.upload": (p) => {
        seen.push(p);
        return { videoId: VIDEO, ...LINKS, stage: "uploading", totalBytes: 2_000_000, camera: "none" };
      },
      "video.get": stagedVideo([
        { stage: "uploading", uploadedBytes: 0, totalBytes: 2_000_000 },
        { stage: "uploading", uploadedBytes: 1_000_000, totalBytes: 2_000_000 },
        { stage: "processing" },
      ]),
    });
    const progress: string[] = [];
    const result = await client.callTool(
      { name: "upload_recording", arguments: { title: "Sign-up demo", visibility: "public" } },
      undefined,
      { onprogress: (p) => void progress.push(String(p.message)) },
    );
    expect(result.isError).toBeFalsy();
    const out = textOf(result);
    expect(out).toMatchObject({ videoId: VIDEO, stage: "processing", viewUrl: LINKS.viewUrl });
    expect(out.note).toMatch(/Uploaded/);
    expect(seen).toEqual([{ title: "Sign-up demo", visibility: "public" }]);
    expect(progress.some((m) => m.includes("Uploading 1.0 MB of 1.9 MB"))).toBe(true);
  });

  it("returns at once with wait: false", async () => {
    let looked = 0;
    const client = await setup({
      "video.upload": () => ({ videoId: VIDEO, ...LINKS, stage: "uploading" }),
      "video.get": () => {
        looked += 1;
        return { videoId: VIDEO, stage: "uploading" };
      },
    });
    const out = textOf(await client.callTool({ name: "upload_recording", arguments: { wait: false } }));
    expect(out.stage).toBe("uploading");
    expect(looked).toBe(0);
  });

  it("returns a cloud recording that is already uploading without waiting", async () => {
    const client = await setup({
      "video.upload": () => ({ videoId: VIDEO, ...LINKS, stage: "uploading", alreadyUploaded: true }),
      "video.get": stagedVideo([{ stage: "processing" }]),
    });
    const out = textOf(await client.callTool({ name: "upload_recording", arguments: {} }));
    expect(out).toMatchObject({ videoId: VIDEO, stage: "processing", alreadyUploaded: true });
  });

  it("reports a failed upload as an error with its code", async () => {
    const client = await setup({
      "video.upload": () => ({ videoId: VIDEO, stage: "uploading" }),
      "video.get": stagedVideo([{ stage: "failed", error: { code: "UPLOAD_FAILED", message: "Upload failed on part 3 of 9" } }]),
    });
    const result = await client.callTool({ name: "upload_recording", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result).error).toMatchObject({ code: "UPLOAD_FAILED", data: { videoId: VIDEO } });
  });

  it("passes the extension's account errors through", async () => {
    const client = await setup({
      "video.upload": () => {
        throw Object.assign(new Error("Uploading and transcripts are part of Recordful Pro."), { code: "PRO_REQUIRED" });
      },
    });
    const result = await client.callTool({ name: "upload_recording", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result).error.code).toBe("PRO_REQUIRED");
  });

  it("rejects bad input before it reaches the extension", async () => {
    let calls = 0;
    const client = await setup({ "video.upload": () => void calls++ });
    for (const args of [{ visibility: "everyone" }, { takeId: "../../etc/passwd" }, { title: "" }]) {
      expect((await client.callTool({ name: "upload_recording", arguments: args })).isError).toBe(true);
    }
    expect(calls).toBe(0);
  });
});

describe("get_video", () => {
  it("answers at once by default, and waits for ready with wait", async () => {
    const client = await setup({ "video.get": stagedVideo([{ stage: "processing" }, { stage: "processing" }, { stage: "ready", title: "Demo" }]) });
    expect(textOf(await client.callTool({ name: "get_video", arguments: { videoId: VIDEO } })).stage).toBe("processing");
    const out = textOf(await client.callTool({ name: "get_video", arguments: { videoId: VIDEO, wait: true } }));
    expect(out).toMatchObject({ stage: "ready", title: "Demo" });
  });

  it("gives up after timeoutMs and says how to keep waiting", async () => {
    const client = await setup({ "video.get": () => ({ videoId: VIDEO, stage: "uploading" }) });
    const out = textOf(await client.callTool({ name: "get_video", arguments: { wait: true, timeoutMs: 1_000 } }));
    expect(out.stage).toBe("uploading");
    expect(out.note).toMatch(/Not ready yet/);
  });

  it("rejects a malformed videoId", async () => {
    const client = await setup({ "video.get": () => ({}) });
    expect((await client.callTool({ name: "get_video", arguments: { videoId: "nope" } })).isError).toBe(true);
  });
});

describe("get_transcript", () => {
  const transcript = (states: Array<Record<string, unknown>>) => {
    const asked: Record<string, unknown>[] = [];
    let i = 0;
    return {
      asked,
      handler: (p: Record<string, unknown>) => {
        asked.push(p);
        return { videoId: VIDEO, ...states[Math.min(i++, states.length - 1)] };
      },
    };
  };

  it("waits through the upload and transcription, then returns the text", async () => {
    const t = transcript([{ status: "uploading" }, { status: "working" }, { status: "done", text: "Hello world.", vtt: "WEBVTT\n\n00:00.000 --> 00:01.000\nHello world." }]);
    const client = await setup({ "video.transcript": t.handler });
    const out = textOf(await client.callTool({ name: "get_transcript", arguments: {} }));
    expect(out).toMatchObject({ videoId: VIDEO, status: "done", text: "Hello world." });
    expect(out.vtt).toBeUndefined();
    expect(t.asked.length).toBe(3);
  });

  it("returns vtt or both on request", async () => {
    const done = { status: "done", text: "Hi.", vtt: "WEBVTT" };
    const client = await setup({ "video.transcript": () => ({ videoId: VIDEO, ...done }) });
    const vtt = textOf(await client.callTool({ name: "get_transcript", arguments: { format: "vtt" } }));
    expect(vtt).toMatchObject({ vtt: "WEBVTT" });
    expect(vtt.text).toBeUndefined();
    expect(textOf(await client.callTool({ name: "get_transcript", arguments: { format: "both" } }))).toMatchObject({ text: "Hi.", vtt: "WEBVTT" });
  });

  it("notes an empty transcript", async () => {
    const client = await setup({ "video.transcript": () => ({ videoId: VIDEO, status: "done", text: "  ", vtt: "WEBVTT" }) });
    expect(textOf(await client.callTool({ name: "get_transcript", arguments: {} })).note).toMatch(/no speech/);
  });

  it("reports a failed transcription as TRANSCRIPTION_FAILED", async () => {
    const client = await setup({ "video.transcript": () => ({ videoId: VIDEO, status: "failed", reason: "no audio track" }) });
    const result = await client.callTool({ name: "get_transcript", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result).error).toMatchObject({ code: "TRANSCRIPTION_FAILED", message: expect.stringMatching(/no audio track/) });
  });

  it("returns the current state with wait: false", async () => {
    const t = transcript([{ status: "working" }]);
    const client = await setup({ "video.transcript": t.handler });
    const out = textOf(await client.callTool({ name: "get_transcript", arguments: { wait: false } }));
    expect(out.status).toBe("working");
    expect(out.note).toMatch(/Still working/);
    expect(t.asked.length).toBe(1);
  });

  it("doesn't wait on a transcript nobody is starting (start: false)", async () => {
    const t = transcript([{ status: "none" }]);
    const client = await setup({ "video.transcript": t.handler });
    const out = textOf(await client.callTool({ name: "get_transcript", arguments: { start: false } }));
    expect(out.status).toBe("none");
    expect(t.asked).toEqual([{ start: false }]);
  });

  it("passes NOT_UPLOADED for a recording only on this computer", async () => {
    const client = await setup({
      "video.transcript": () => {
        throw Object.assign(new Error("The last recording is only on this computer. Upload it with upload_recording first."), {
          code: "NOT_UPLOADED",
        });
      },
    });
    const result = await client.callTool({ name: "get_transcript", arguments: {} });
    expect(textOf(result).error.code).toBe("NOT_UPLOADED");
  });
});

describe("list tools", () => {
  it("list_videos passes limit and query, and validates them", async () => {
    const seen: Record<string, unknown>[] = [];
    const client = await setup({
      "video.list": (p) => {
        seen.push(p);
        return { videos: [{ videoId: VIDEO, title: "Demo", ...LINKS }] };
      },
    });
    const out = textOf(await client.callTool({ name: "list_videos", arguments: { limit: 5, query: "Demo" } }));
    expect(out.videos).toHaveLength(1);
    expect(seen).toEqual([{ limit: 5, query: "Demo" }]);
    expect((await client.callTool({ name: "list_videos", arguments: { limit: 500 } })).isError).toBe(true);
  });

  it("list_recordings lists local takes", async () => {
    const client = await setup({ "takes.list": () => ({ takes: [{ takeId: "recording-1.webm", bytes: 10 }] }) });
    expect(textOf(await client.callTool({ name: "list_recordings", arguments: {} })).takes).toHaveLength(1);
  });
});
