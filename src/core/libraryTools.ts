// Tools for managing what's already on recordful.app (Recordful Pro): rename
// and set who may watch, read and add comments and likes, organise into
// folders, delete, and check storage. Everything runs as the signed-in user
// through the extension, so the server's own permission checks apply.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BridgeError, ErrorCode } from "../protocol/errors.js";
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
      description: `${PRO} Change a video's title and/or who may watch it: "private" (only the user), "workspace" (their team) or "public" (anyone with the link). It can also lock the share link for people outside the workspace: password (null removes it; use only a password the user gave you, never invent one) and expiresAt (null: never). Returns passwordProtected and linkExpiresAt, never the password. ${ASK} Defaults to the last recording. Only the person who recorded it, or the workspace owner, can.`,
      inputSchema: videoParams.update,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => handle(() => call(Method.VideoUpdate, parseVideoParams(videoParams.update, args), 40_000)),
  );

  server.registerTool(
    "delete_video",
    {
      title: "Delete a video",
      description: `${PRO} Delete a video from recordful.app. It goes to trash, where restore_video can bring it back for 7 days; after that it and its files are gone for good. There is no default video: name it. Call with dryRun: true first to get what would go, show the user, and only after their yes call again with confirm: true.`,
      inputSchema: videoParams.remove,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      handle(() => {
        const params = parseVideoParams(videoParams.remove, args);
        if (params.dryRun === params.confirm) {
          throw new BridgeError(
            ErrorCode.InvalidParams,
            "Pass dryRun: true to see what would be deleted, or confirm: true once the user has said yes to this exact video (not both).",
          );
        }
        return call(Method.VideoDelete, params, 40_000);
      }),
  );

  server.registerTool(
    "list_trash",
    {
      title: "List deleted videos",
      description: `${PRO} Videos in trash that the user can see: videoId, title, when it was deleted and when it's gone for good (7 days later). Read-only.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => handle(() => call(Method.TrashList, {}, 40_000)),
  );

  server.registerTool(
    "restore_video",
    {
      title: "Restore a deleted video",
      description: `${PRO} Bring a video back out of trash (list_trash shows them), with its links as before. Only the person who recorded it, or the workspace owner, can.`,
      inputSchema: videoParams.restore,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => handle(() => call(Method.VideoRestore, parseVideoParams(videoParams.restore, args), 40_000)),
  );

  server.registerTool(
    "get_video_activity",
    {
      title: "Read views, likes and comments",
      description: `${PRO} What viewers did with a video: its view count, where views came from (viewsBy: sources such as Direct, Google or X, link page vs embeds, top countries), views per UTC day over the last days (daily, oldest first), likes, and every comment (oldest first, with author and time). Read-only. Defaults to the last recording.`,
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
    "delete_comment",
    {
      title: "Delete a comment",
      description: `${PRO} Delete one comment from a video (get_video_activity lists them with their ids). Its author can, and so can the person who recorded the video or the workspace owner. It can't be brought back: show the user the comment and wait for their yes, then call with confirm: true.`,
      inputSchema: videoParams.deleteComment,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => handle(() => call(Method.VideoCommentDelete, parseVideoParams(videoParams.deleteComment, args), 40_000)),
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
    "get_analytics",
    {
      title: "Views across all videos",
      description: `${PRO} How the user's whole library is watched: total views and views per UTC day over the last days (default 30), plus the ten most viewed videos in that time with links. Covers the videos the user can see, not those in trash. get_video_activity has one video's detail. Read-only.`,
      inputSchema: videoParams.analytics,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => handle(() => call(Method.AnalyticsGet, parseVideoParams(videoParams.analytics, args), 40_000)),
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
