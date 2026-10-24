// Tools for managing what's already on recordful.app (Recordful Pro): rename
// and set who may watch, read and add comments and likes, organise into
// folders, delete, and check storage. Everything runs as the signed-in user
// through the extension, so the server's own permission checks apply.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Method } from "../protocol/methods.js";
import { parseVideoParams, videoParams } from "../protocol/video.js";
import type { Call } from "../workflows.js";

type Handle = (fn: () => Promise<unknown>) => Promise<CallToolResult>;

const PRO = "Recordful Pro only (check get_status recorder.account.plan first).";
const ASK = "Show the user exactly what you will change and wait for their yes first.";

export const registerLibraryTools = (server: McpServer, call: Call, handle: Handle) => {
  server.registerTool(
    "update_video",
    {
      title: "Rename a video or change who can watch",
      description: `${PRO} Change a video's title and/or who may watch it: "private" (only the user), "workspace" (their team) or "public" (anyone with the link). ${ASK} Defaults to the last recording. Only the person who recorded it, or the workspace owner, can.`,
      inputSchema: videoParams.update,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => handle(() => call(Method.VideoUpdate, parseVideoParams(videoParams.update, args), 40_000)),
  );

  server.registerTool(
    "delete_video",
    {
      title: "Delete a video",
      description: `${PRO} Permanently delete a video and its files from recordful.app. This can't be undone, and there is no default video: name it. Ask the user to confirm this exact video (title and link) first, then call with confirm: true.`,
      inputSchema: videoParams.remove,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => handle(() => call(Method.VideoDelete, parseVideoParams(videoParams.remove, args), 40_000)),
  );

  server.registerTool(
    "get_video_activity",
    {
      title: "Read views, likes and comments",
      description: `${PRO} What viewers did with a video: its view count, likes, and every comment (oldest first, with author and time). Read-only. Defaults to the last recording.`,
      inputSchema: videoParams.activity,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => handle(() => call(Method.VideoEngagement, parseVideoParams(videoParams.activity, args), 40_000)),
  );

  server.registerTool(
    "comment_on_video",
    {
      title: "Comment on a video",
      description: `${PRO} Post a comment on a video as the signed-in user. It is public to everyone who can watch the video. ${ASK} Pass the comment exactly as the user approved it. Defaults to the last recording.`,
      inputSchema: videoParams.comment,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => handle(() => call(Method.VideoComment, parseVideoParams(videoParams.comment, args), 40_000)),
  );

  server.registerTool(
    "like_video",
    {
      title: "Like or unlike a video",
      description: `${PRO} Like a video as the signed-in user (liked: false removes it). Returns the new like count. Defaults to the last recording.`,
      inputSchema: videoParams.like,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => handle(() => call(Method.VideoLike, parseVideoParams(videoParams.like, args), 40_000)),
  );

  server.registerTool(
    "list_folders",
    {
      title: "List folders",
      description: `${PRO} The user's folders on recordful.app: folderId, name, parentId (null at the top level) and whether it's shared. list_videos shows each video's folderId.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => handle(() => call(Method.FolderList, {}, 40_000)),
  );

  server.registerTool(
    "create_folder",
    {
      title: "Create a folder",
      description: `${PRO} Create a folder, at the top level or inside another folder. ${ASK}`,
      inputSchema: videoParams.createFolder,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => handle(() => call(Method.FolderCreate, parseVideoParams(videoParams.createFolder, args), 40_000)),
  );

  server.registerTool(
    "move_videos",
    {
      title: "Move videos into a folder",
      description: `${PRO} Move videos into a folder (folderId null moves them to the top level). Moving into a shared folder shares them, except private videos. ${ASK} Videos the user can't manage come back as skipped.`,
      inputSchema: videoParams.move,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => handle(() => call(Method.VideoMove, parseVideoParams(videoParams.move, args), 40_000)),
  );

  server.registerTool(
    "get_storage",
    {
      title: "Check storage",
      description: `${PRO} How much of the user's Recordful cloud storage is used (bytes, percent) and whether more can be uploaded. Read-only.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => handle(() => call(Method.StorageGet, {}, 40_000)),
  );
};
