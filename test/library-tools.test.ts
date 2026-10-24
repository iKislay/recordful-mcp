import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeServer } from "../src/bridge/BridgeServer.js";
import { loadConfig } from "../src/config.js";
import { silentLogger } from "../src/logger.js";
import { createMcpServer } from "../src/mcp/createMcpServer.js";
import { connectFakeExtension, memoryPairings, type Handler } from "./helpers/fakeExtension.js";

const VIDEO = "0b0b8f6e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const FOLDER = "1c1c8f6e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

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

type Result = Awaited<ReturnType<Client["callTool"]>>;
const textOf = (result: Result) => (result.content as Array<{ text: string }>)[0]!.text;
const json = (result: Result) => JSON.parse(textOf(result));

describe("library tools", () => {
  it("passes each call to the extension with the parameters the agent gave", async () => {
    const seen: Record<string, Record<string, unknown>> = {};
    const record =
      (method: string, answer: unknown): Handler =>
      (params) => {
        seen[method] = params;
        return answer;
      };
    const client = await setup({
      "video.update": record("video.update", { videoId: VIDEO, title: "New", visibility: "private" }),
      "video.engagement": record("video.engagement", { videoId: VIDEO, views: 5, likes: 1, comments: [] }),
      "video.comment": record("video.comment", { videoId: VIDEO, comment: { id: "c" } }),
      "video.like": record("video.like", { videoId: VIDEO, liked: false, likes: 0 }),
      "folder.list": record("folder.list", { folders: [{ folderId: FOLDER, name: "Demos", parentId: null, shared: false }] }),
      "folder.create": record("folder.create", { folderId: FOLDER, name: "Demos" }),
      "video.move": record("video.move", { folderId: FOLDER, moved: 1, skipped: [] }),
      "storage.get": record("storage.get", { usedBytes: 1, limitBytes: 100, usedPercent: 1, canUpload: true }),
    });

    expect(json(await client.callTool({ name: "update_video", arguments: { title: "New", visibility: "private" } })).title).toBe("New");
    expect(seen["video.update"]).toEqual({ title: "New", visibility: "private" });

    expect(json(await client.callTool({ name: "get_video_activity", arguments: { videoId: VIDEO } })).views).toBe(5);
    expect(seen["video.engagement"]).toEqual({ videoId: VIDEO });

    await client.callTool({ name: "comment_on_video", arguments: { body: "  Great flow  " } });
    expect(seen["video.comment"]).toEqual({ body: "Great flow" });

    expect(json(await client.callTool({ name: "like_video", arguments: { liked: false } })).liked).toBe(false);
    expect(seen["video.like"]).toEqual({ liked: false });

    expect(json(await client.callTool({ name: "list_folders", arguments: {} })).folders[0].name).toBe("Demos");
    await client.callTool({ name: "create_folder", arguments: { name: "Demos", parentId: FOLDER } });
    expect(seen["folder.create"]).toEqual({ name: "Demos", parentId: FOLDER });

    await client.callTool({ name: "move_videos", arguments: { videoIds: [VIDEO], folderId: null } });
    expect(seen["video.move"]).toEqual({ videoIds: [VIDEO], folderId: null });

    expect(json(await client.callTool({ name: "get_storage", arguments: {} })).canUpload).toBe(true);
  });

  it("won't delete without the exact video and confirm: true", async () => {
    let deletes = 0;
    const client = await setup({
      "video.delete": (p) => {
        deletes += 1;
        return { deleted: true, videoId: p.videoId };
      },
    });
    const noConfirm = await client.callTool({ name: "delete_video", arguments: { videoId: VIDEO } });
    expect(noConfirm.isError).toBe(true);
    const falseConfirm = await client.callTool({ name: "delete_video", arguments: { videoId: VIDEO, confirm: false } });
    expect(falseConfirm.isError).toBe(true);
    const noVideo = await client.callTool({ name: "delete_video", arguments: { confirm: true } });
    expect(noVideo.isError).toBe(true);
    expect(deletes).toBe(0);

    const ok = await client.callTool({ name: "delete_video", arguments: { videoId: VIDEO, confirm: true } });
    expect(json(ok)).toEqual({ deleted: true, videoId: VIDEO });
    expect(deletes).toBe(1);
  });

  it("rejects bad input before it reaches the extension", async () => {
    let calls = 0;
    const client = await setup({
      "video.update": () => (calls += 1),
      "video.comment": () => (calls += 1),
      "folder.create": () => (calls += 1),
      "video.move": () => (calls += 1),
    });
    const attempts = [
      client.callTool({ name: "update_video", arguments: { visibility: "everyone" } }),
      client.callTool({ name: "comment_on_video", arguments: { body: "   " } }),
      client.callTool({ name: "comment_on_video", arguments: { body: "x".repeat(2001) } }),
      client.callTool({ name: "create_folder", arguments: { name: "" } }),
      client.callTool({ name: "move_videos", arguments: { videoIds: [] } }),
      client.callTool({ name: "move_videos", arguments: { videoIds: ["nope"] } }),
    ];
    for (const result of await Promise.all(attempts)) expect(result.isError).toBe(true);
    expect(calls).toBe(0);
  });

  it("relays the plan errors so the agent stops", async () => {
    const client = await setup({
      "video.comment": () => {
        throw Object.assign(new Error("Uploads, cloud videos and transcripts are Recordful Pro features"), { code: "PRO_REQUIRED" });
      },
    });
    const result = await client.callTool({ name: "comment_on_video", arguments: { body: "hi" } });
    expect(result.isError).toBe(true);
    expect(json(result).error.code).toBe("PRO_REQUIRED");
  });

  it("marks reads as read-only and delete as destructive", async () => {
    const client = await setup({});
    const tools = new Map((await client.listTools()).tools.map((t) => [t.name, t.annotations]));
    for (const name of ["get_video_activity", "list_folders", "get_storage"]) expect(tools.get(name)?.readOnlyHint).toBe(true);
    expect(tools.get("delete_video")?.destructiveHint).toBe(true);
    expect(tools.get("comment_on_video")?.idempotentHint).toBe(false);
  });
});
