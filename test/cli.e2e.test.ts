// The real CLI, run as separate processes: the first command starts the
// background helper, a fake extension connects to it, and every command
// after that shares it as a peer. Exercises the whole path an agent with a
// shell uses: record, upload, list, transcript.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectFakeExtension, TOKEN, type FakeExtension } from "./helpers/fakeExtension.js";

const VIDEO = "0b0b8f6e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const LINKS = { viewUrl: `https://recordful.app/view/${VIDEO}`, editUrl: `https://recordful.app/editor/${VIDEO}/edit` };
const CLI = resolve(__dirname, "..", "src", "cli.ts");

let dir: string;
let port: number;
let env: NodeJS.ProcessEnv;
let extension: FakeExtension | null = null;
let stopReconnecting = false;
let looks = 0;

const freePort = () =>
  new Promise<number>((done) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port: p } = s.address() as { port: number };
      s.close(() => done(p));
    });
  });

const handlers = {
  "status.get": () => ({ state: "idle", account: { signedIn: true, pro: true, email: "demo@example.com" } }),
  "recording.stop": () => ({ outcome: "stopped", recording: { kind: "cloud", videoId: VIDEO, ...LINKS } }),
  "takes.list": () => ({ takes: [{ takeId: "recording-1.webm", bytes: 3_145_728, recordedAt: "2026-10-21T10:00:00.000Z", isLastRecording: true }] }),
  "video.upload": () => ({ videoId: VIDEO, ...LINKS, stage: "uploading", totalBytes: 3_145_728 }),
  "video.get": () => ({ videoId: VIDEO, ...LINKS, title: "Demo", stage: looks++ < 1 ? "uploading" : "processing", uploadedBytes: 1, totalBytes: 3_145_728 }),
  "video.list": () => ({ videos: [{ videoId: VIDEO, title: "Demo", createdAt: "2026-10-21", ...LINKS }] }),
  "video.transcript": () => ({ videoId: VIDEO, status: "done", text: "Hello world.", vtt: "WEBVTT" }),
  "video.engagement": () => ({
    videoId: VIDEO,
    views: 12,
    likes: 3,
    comments: [{ id: "c1", body: "Nice demo", createdAt: "2026-10-21T10:00:00.000Z", author: "Sam" }],
  }),
  "video.comment": (p: Record<string, unknown>) => ({ videoId: VIDEO, comment: { id: "c2", body: p.body } }),
  "video.move": (p: Record<string, unknown>) => ({ folderId: p.folderId, moved: (p.videoIds as string[]).length, skipped: [] }),
  "video.delete": (p: Record<string, unknown>) => ({ deleted: true, videoId: p.videoId }),
};

// Like the real extension: keeps dialling until whoever owns the port answers.
const keepConnecting = async () => {
  while (!stopReconnecting) {
    if (!extension) {
      const ext = connectFakeExtension({ port, handlers });
      try {
        await ext.ready;
        extension = ext;
        void ext.closed.then(() => {
          if (extension === ext) extension = null;
        });
      } catch {
        ext.close();
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
};

const run = (args: string[]) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], { env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "recordful-cli-"));
  port = await freePort();
  env = {
    ...process.env,
    RECORDFUL_BRIDGE_PORT: String(port),
    RECORDFUL_BRIDGE_STATE_PATH: join(dir, "state.json"),
    RECORDFUL_BRIDGE_TOKEN: TOKEN,
    RECORDFUL_BRIDGE_ALLOWED_EXTENSION_IDS: "*",
    RECORDFUL_BRIDGE_HELPER_IDLE_MS: "4000",
  };
  void keepConnecting();
});

afterAll(async () => {
  stopReconnecting = true;
  extension?.close();
  // The helper exits on its own once idle; wait for the port to free up.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const free = await new Promise<boolean>((done) => {
      const s = createServer();
      s.once("error", () => done(false));
      s.listen(port, "127.0.0.1", () => s.close(() => done(true)));
    });
    if (free) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await rm(dir, { recursive: true, force: true });
}, 30_000);

describe("recordful-mcp CLI", () => {
  it("status works with nothing running", async () => {
    const { code, stdout } = await run(["status", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ running: false, extensionConnected: false });
  });

  it("starts the helper on first use and lists local recordings", async () => {
    const { code, stdout, stderr } = await run(["recordings", "--json"]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout).takes[0].takeId).toBe("recording-1.webm");
  }, 30_000);

  it("status now shows the helper and the account", async () => {
    const { stdout } = await run(["status"]);
    expect(stdout).toMatch(/recordful-mcp running:\s+yes/);
    expect(stdout).toMatch(/Recordful connected:\s+yes/);
    expect(stdout).toMatch(/demo@example.com, Pro/);
  }, 30_000);

  it("stop says where a cloud recording went", async () => {
    const { code, stdout } = await run(["stop"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(`Stopped. Uploading to recordful.app: ${LINKS.viewUrl}`);
  }, 30_000);

  it("upload waits for the upload and prints the links", async () => {
    const { code, stdout, stderr } = await run(["upload", "--title", "Demo"]);
    expect(code).toBe(0);
    expect(stdout).toContain(`Watch: ${LINKS.viewUrl}`);
    expect(stdout).toContain(`Edit:  ${LINKS.editUrl}`);
    expect(stderr).toMatch(/Uploading/);
  }, 30_000);

  it("transcript prints the text, json prints everything", async () => {
    const text = await run(["transcript"]);
    expect(text.code).toBe(0);
    expect(text.stdout.trim()).toBe("Hello world.");
    const json = await run(["transcript", "--format", "json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({ status: "done", text: "Hello world.", vtt: "WEBVTT" });
  }, 30_000);

  it("videos lists videos with links", async () => {
    const { stdout } = await run(["videos"]);
    expect(stdout).toContain(VIDEO);
    expect(stdout).toContain(LINKS.viewUrl);
  }, 30_000);

  it("reads activity and posts a comment", async () => {
    const activity = await run(["activity"]);
    expect(activity.stdout).toContain("12 views, 3 likes, 1 comments");
    expect(activity.stdout).toContain("Sam");
    expect(activity.stdout).toContain("Nice demo");
    const posted = await run(["comment", "--body", "Thanks!", "--json"]);
    expect(JSON.parse(posted.stdout).comment.body).toBe("Thanks!");
    const noBody = await run(["comment"]);
    expect(noBody.code).toBe(1);
    expect(noBody.stderr).toMatch(/--body/);
  }, 30_000);

  it("moves videos, and won't delete without --yes", async () => {
    const moved = await run(["move", VIDEO, "--to", VIDEO, "--json"]);
    expect(JSON.parse(moved.stdout)).toMatchObject({ moved: 1, folderId: VIDEO });
    const refused = await run(["delete", VIDEO]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/permanent/);
    const deleted = await run(["delete", VIDEO, "--yes", "--json"]);
    expect(JSON.parse(deleted.stdout)).toEqual({ deleted: true, videoId: VIDEO });
  }, 30_000);

  it("fails clearly on bad input, with exit code 1", async () => {
    const bad = await run(["video", "not-a-video-id"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/INVALID_PARAMS/);
    const unknown = await run(["frobnicate"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/unknown command/);
  }, 30_000);
});
