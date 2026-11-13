// Multi-step flows shared by the MCP tools and the CLI: upload and wait,
// follow a video until it's ready, transcribe and wait. Each polls the
// extension with short requests, so nothing long rides on one call, and
// reports progress as it goes.
import { BridgeError, ErrorCode } from "./protocol/errors.js";
import { Method } from "./protocol/methods.js";
import { parseVideoParams, videoParams } from "./protocol/video.js";

export type Call = (method: string, params: Record<string, unknown>, extraWaitMs?: number) => Promise<unknown>;
export type Progress = (message: string, progress?: number, total?: number) => Promise<void> | void;

// What the extension answers (see recordful's agentBridge/videoCommands.js).
export interface VideoState {
  videoId: string;
  stage: "uploading" | "processing" | "ready" | "failed";
  uploadedBytes?: number | null;
  totalBytes?: number | null;
  error?: { code: string; message: string };
  [key: string]: unknown;
}

export interface TranscriptState {
  videoId: string;
  status: "done" | "working" | "uploading" | "failed" | "none";
  text?: string;
  vtt?: string;
  reason?: string | null;
  [key: string]: unknown;
}

export const POLL = { videoMs: 2_000, transcriptMs: 3_000 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const mb = (bytes?: number | null) =>
  typeof bytes === "number" ? `${(bytes / 1_048_576).toFixed(1)} MB` : "?";

const failedUpload = (state: VideoState) =>
  new BridgeError(state.error?.code ?? ErrorCode.UploadFailed, state.error?.message ?? "The upload failed.", {
    videoId: state.videoId,
  });

// Follows a video until `done(state)`, or until the time runs out.
export const followVideo = async (
  call: Call,
  videoId: string,
  done: (state: VideoState) => boolean,
  timeoutMs: number,
  progress: Progress,
): Promise<{ state: VideoState; timedOut: boolean; waitedMs: number }> => {
  const started = Date.now();
  for (;;) {
    const state = (await call(Method.VideoGet, { videoId }, 40_000)) as VideoState;
    if (state.stage === "failed") throw failedUpload(state);
    if (done(state)) return { state, timedOut: false, waitedMs: Date.now() - started };
    if (Date.now() - started >= timeoutMs) return { state, timedOut: true, waitedMs: Date.now() - started };
    if (state.stage === "uploading" && state.totalBytes) {
      await progress(`Uploading ${mb(state.uploadedBytes)} of ${mb(state.totalBytes)}`, state.uploadedBytes ?? 0, state.totalBytes);
    } else {
      await progress(state.stage === "uploading" ? "Uploading" : "Processing on recordful.app");
    }
    await sleep(POLL.videoMs);
  }
};

export const uploadAndWait = async (
  call: Call,
  args: Record<string, unknown>,
  progress: Progress,
): Promise<Record<string, unknown>> => {
  const { wait = true, timeoutMs = 240_000, ...rest } = args as { wait?: boolean; timeoutMs?: number };
  const params = parseVideoParams(videoParams.upload, rest);
  await progress("Reading the recording and creating the video");
  // Reading a long recording off disk can take a moment before the upload starts.
  const started = (await call(Method.VideoUpload, params, 90_000)) as VideoState;
  if (!wait || started.stage !== "uploading") return started;
  const { state, timedOut, waitedMs } = await followVideo(call, started.videoId, (s) => s.stage !== "uploading", timeoutMs, progress);
  return {
    ...started,
    ...state,
    waitedMs,
    note: timedOut
      ? "Still uploading. Call get_video with wait: true to keep waiting."
      : "Uploaded. get_transcript reads it back.",
  };
};

export const getVideoAndWait = async (
  call: Call,
  args: Record<string, unknown>,
  progress: Progress,
): Promise<Record<string, unknown>> => {
  const { wait = false, timeoutMs = 180_000, ...rest } = args as { wait?: boolean; timeoutMs?: number };
  const params = parseVideoParams(videoParams.get, rest);
  const first = (await call(Method.VideoGet, params, 40_000)) as VideoState;
  if (first.stage === "failed") throw failedUpload(first);
  if (!wait || first.stage === "ready") return first;
  const { state, timedOut, waitedMs } = await followVideo(call, first.videoId, (s) => s.stage === "ready", timeoutMs, progress);
  return { ...state, waitedMs, ...(timedOut ? { note: "Not ready yet. Call again with wait: true to keep waiting." } : {}) };
};

const MAX_MATCHES = 30;

const toMs = (stamp: string) =>
  stamp.split(":").reduce((total, part) => total * 60 + Number(part), 0) * 1000;

// The cues of a WebVTT transcript that mention `query` (any case), with their
// times, so an agent can find a moment without reading the whole transcript.
export const findCues = (vtt: string, query: string) => {
  const needle = query.trim().toLowerCase();
  const matches: Array<{ startMs: number; endMs: number; text: string }> = [];
  let total = 0;
  for (const block of vtt.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const at = lines.findIndex((line) => line.includes("-->"));
    if (at < 0) continue;
    const text = lines.slice(at + 1).join(" ").trim();
    if (!text.toLowerCase().includes(needle)) continue;
    total++;
    if (matches.length >= MAX_MATCHES) continue;
    const [start = "", end = ""] = (lines[at] ?? "").split("-->").map((side) => side.trim().split(/\s/)[0] ?? "");
    matches.push({ startMs: Math.round(toMs(start)), endMs: Math.round(toMs(end)), text });
  }
  return { matches, totalMatches: total, ...(total > MAX_MATCHES ? { note: `Showing the first ${MAX_MATCHES} of ${total}; narrow the query.` } : {}) };
};

export const transcriptAndWait = async (
  call: Call,
  args: Record<string, unknown>,
  progress: Progress,
): Promise<Record<string, unknown>> => {
  const {
    wait = true,
    timeoutMs = 300_000,
    format = "text",
    query,
    ...rest
  } = args as { wait?: boolean; timeoutMs?: number; format?: "text" | "vtt" | "both"; query?: string };
  const params = parseVideoParams(videoParams.transcript, rest);
  const started = Date.now();
  for (;;) {
    const now = (await call(Method.VideoTranscript, params, 100_000)) as TranscriptState;
    if (now.status === "done") {
      const { text = "", vtt = "", ...about } = now;
      if (query?.trim()) return { ...about, query, ...findCues(vtt, query) };
      return {
        ...about,
        ...(format !== "vtt" ? { text } : {}),
        ...(format !== "text" ? { vtt } : {}),
        ...(text.trim() ? {} : { note: "The transcript is empty: no speech was heard in this recording." }),
      };
    }
    if (now.status === "failed") {
      throw new BridgeError(ErrorCode.TranscriptionFailed, `Transcription failed${now.reason ? `: ${now.reason}` : ""}.`, {
        videoId: now.videoId,
      });
    }
    // Nothing will change while nobody starts it.
    const idle = now.status === "none" && params.start === false;
    if (!wait || idle || Date.now() - started >= timeoutMs) {
      return {
        ...now,
        note:
          now.status === "none"
            ? "Not transcribed yet. Call again (start defaults to true) to transcribe it."
            : "Still working on it. Call get_transcript again to keep waiting.",
      };
    }
    // Asking to start again on the next look is harmless: the site ignores it
    // while one runs, and it starts one once an upload finishes.
    await progress(now.status === "uploading" ? "Waiting for the upload to finish" : "Transcribing");
    await sleep(POLL.transcriptMs);
  }
};
