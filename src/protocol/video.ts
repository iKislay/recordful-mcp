// Params for what an agent does with recordings once they exist: upload a
// local one, follow a video, list videos, read a transcript back. Validated
// here before anything goes on the wire; the extension validates again.
import { z } from "zod";
import { BridgeError, ErrorCode } from "./errors.js";

export const VideoId = z
  .string()
  .regex(/^[0-9a-f-]{36}$/i, "videoId must be a Recordful video ID")
  .describe("Recordful video ID (from stop_recording, upload_recording or list_videos). Defaults to the last recording.");

export const TakeId = z
  .string()
  .regex(/^recording-[\w.-]{1,200}\.(webm|mp4)$/, "takeId must come from list_recordings")
  .describe("A local recording from list_recordings. Defaults to the last recording.");

export const FolderId = z
  .string()
  .regex(/^[0-9a-f-]{36}$/i, "must be a folder ID from list_folders")
  .describe("A folder ID from list_folders.");

export const VISIBILITIES = ["private", "workspace", "public"] as const;

export const videoParams = {
  upload: {
    takeId: TakeId.optional(),
    title: z.string().trim().min(1).max(200).optional().describe("Title on recordful.app. Defaults to the recording's date."),
    visibility: z
      .enum(VISIBILITIES)
      .optional()
      .describe('Who may watch: "private" (only the user), "workspace" (their team), or "public" (anyone with the link). Defaults to the workspace setting.'),
    force: z.boolean().optional().describe("Upload again even if this recording was uploaded before."),
  },
  get: { videoId: VideoId.optional() },
  list: {
    limit: z.number().int().min(1).max(50).optional().describe("How many, newest first (default 10)."),
    query: z.string().max(200).optional().describe("Only videos whose title contains this."),
  },
  transcript: {
    videoId: VideoId.optional(),
    start: z.boolean().optional().describe("Start transcribing if there's no transcript yet (default true)."),
  },
  update: {
    videoId: VideoId.optional(),
    title: z.string().trim().min(1).max(200).optional().describe("New title."),
    visibility: z.enum(VISIBILITIES).optional().describe('Who may watch: "private", "workspace" (their team) or "public" (anyone with the link).'),
  },
  remove: {
    videoId: z.string().regex(/^[0-9a-f-]{36}$/i, "videoId must be a Recordful video ID").describe("The video to delete. Required: there is no default for a delete."),
    confirm: z.literal(true).describe("Must be true, and only after the user has confirmed deleting this exact video."),
  },
  activity: { videoId: VideoId.optional() },
  comment: {
    videoId: VideoId.optional(),
    body: z.string().trim().min(1).max(2000).describe("The comment text, exactly as the user approved it."),
  },
  like: {
    videoId: VideoId.optional(),
    liked: z.boolean().optional().describe("true to like (default), false to remove the like."),
  },
  createFolder: {
    name: z.string().trim().min(1).max(120).describe("The folder's name."),
    parentId: FolderId.optional().describe("The folder to create it in (from list_folders). Default: the top level."),
  },
  move: {
    videoIds: z.array(z.string().regex(/^[0-9a-f-]{36}$/i, "each must be a Recordful video ID")).min(1).max(200).describe("The videos to move."),
    folderId: FolderId.nullable().optional().describe("The destination folder (from list_folders), or null for the top level."),
  },
} as const;

export const parseVideoParams = <S extends z.ZodRawShape>(shape: S, params: unknown): z.infer<z.ZodObject<S>> => {
  const result = z.object(shape).strict().safeParse(params ?? {});
  if (!result.success) {
    throw new BridgeError(
      ErrorCode.InvalidParams,
      result.error.issues.map((i) => `${i.path.join(".") || "params"}: ${i.message}`).join("; "),
    );
  }
  return result.data;
};
