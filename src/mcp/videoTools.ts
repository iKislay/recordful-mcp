// Tools for recordings once they exist: upload a local one, follow a video
// until it's ready, list videos and local recordings, and read a transcript
// back. The waiting lives in ../workflows.ts (shared with the CLI); here it
// is wrapped as tools that report MCP progress while they wait.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Method } from "../protocol/methods.js";
import { parseVideoParams, videoParams } from "../protocol/video.js";
import { getVideoAndWait, transcriptAndWait, uploadAndWait, type Call, type Progress } from "../workflows.js";

type Handle = (fn: () => Promise<unknown>) => Promise<CallToolResult>;
type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// Waits are bounded so a tool call always returns; the agent can call again.
const waitTimeout = (fallback: number) =>
  z
    .number()
    .int()
    .min(1_000)
    .max(30 * 60_000)
    .optional()
    .describe(`How long to wait, in milliseconds (default ${fallback}). If it runs out, call again to keep waiting.`);

// MCP progress notifications, for clients that asked for them.
const progressFor = (extra: Extra | undefined): Progress => {
  const token = extra?._meta?.progressToken;
  let step = 0;
  return async (message, progress, total) => {
    if (token === undefined || !extra) return;
    step += 1;
    await extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress: progress ?? step, ...(total ? { total } : {}), message },
      })
      .catch(() => {});
  };
};

export const registerVideoTools = (server: McpServer, call: Call, handle: Handle) => {
  server.registerTool(
    "list_recordings",
    {
      title: "List local recordings",
      description:
        "List the recordings saved on this computer (newest first): each takeId, size, when it was recorded, and its videoId if it was uploaded. Recordings made while signed in to Recordful Pro go straight to the cloud instead; see list_videos.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => handle(() => call(Method.TakesList, {})),
  );

  server.registerTool(
    "upload_recording",
    {
      title: "Upload a recording",
      description:
        "Recordful Pro only (check get_status recorder.account.plan first). Upload a local recording to recordful.app and, by default, wait until the upload finishes. Defaults to the last recording. Returns the videoId and its view and edit links. A recording made in the cloud is already uploading, so this just returns it. Then get_transcript reads it back.",
      inputSchema: {
        ...videoParams.upload,
        wait: z.boolean().optional().describe("Wait for the upload to finish (default true)."),
        timeoutMs: waitTimeout(240_000),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args, extra) => handle(() => uploadAndWait(call, args, progressFor(extra))),
  );

  server.registerTool(
    "get_video",
    {
      title: "Get a video",
      description:
        'A Recordful video\'s title, length, who may watch it, its view and edit links, and its upload stage: "uploading" → "processing" → "ready". With wait, keeps checking until it\'s ready. Defaults to the last recording.',
      inputSchema: {
        ...videoParams.get,
        wait: z.boolean().optional().describe('Wait until the video is "ready" (default false).'),
        timeoutMs: waitTimeout(180_000),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, extra) => handle(() => getVideoAndWait(call, args, progressFor(extra))),
  );

  server.registerTool(
    "list_videos",
    {
      title: "List videos",
      description:
        "List the user's videos on recordful.app, newest first: videoId, title, date, length, who may watch, and links. Optionally filter by title.",
      inputSchema: videoParams.list,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => handle(() => call(Method.VideoList, parseVideoParams(videoParams.list, args), 40_000)),
  );

  server.registerTool(
    "get_transcript",
    {
      title: "Read a transcript",
      description:
        'Recordful Pro only (check get_status recorder.account.plan first). Read back what was said in a Recordful video. Starts transcribing if it hasn\'t been yet, and by default waits until it\'s done, including for an upload still in progress. format: "text" (default), "vtt" (timed captions), or "both". Defaults to the last recording; a recording only on this computer must be uploaded first (upload_recording).',
      inputSchema: {
        ...videoParams.transcript,
        format: z.enum(["text", "vtt", "both"]).optional().describe('"text" (default), "vtt" (with timestamps), or "both".'),
        wait: z.boolean().optional().describe("Wait until the transcript is ready (default true)."),
        timeoutMs: waitTimeout(300_000),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args, extra) => handle(() => transcriptAndWait(call, args, progressFor(extra))),
  );
};
