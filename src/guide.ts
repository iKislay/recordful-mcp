// `recordful-mcp guide --json`: what this install can do, in one document an AI
// agent can read instead of relying on remembered commands. Keep it in step
// with the CLI's help and the MCP tools (a test checks the tool names).
import { ErrorCode } from "./protocol/errors.js";
import { TARGETS } from "./install.js";

export const MCP_TOOLS = [
  "get_status",
  "start_recording",
  "stop_recording",
  "pause_recording",
  "resume_recording",
  "probe_capture",
  "navigate",
  "snapshot",
  "click",
  "type",
  "press",
  "scroll",
  "wait_for",
  "screenshot",
  "list_recordings",
  "upload_recording",
  "get_video",
  "list_videos",
  "get_transcript",
] as const;

interface CommandInfo {
  command: string;
  summary: string;
  pro?: true;
  needsRecordful: boolean;
}

const COMMANDS: CommandInfo[] = [
  { command: "status", summary: "Connection, recorder, account and pairing state", needsRecordful: false },
  { command: "start [--tab <id>]", summary: "Start recording with the user's Recordful settings", needsRecordful: true },
  { command: "pause | resume", summary: "Pause or resume the recording", needsRecordful: true },
  { command: "stop", summary: "Stop; says where the recording went", needsRecordful: true },
  { command: "recordings", summary: "Recordings saved on this computer", needsRecordful: true },
  { command: "upload [<takeId>] [--title t] [--visibility private|workspace|public] [--force] [--no-wait]", summary: "Upload a recording and return its links", pro: true, needsRecordful: true },
  { command: "videos [--limit n] [--query text]", summary: "List the user's videos on recordful.app", pro: true, needsRecordful: true },
  { command: "video [<videoId>] [--wait]", summary: "One video's links and upload stage", pro: true, needsRecordful: true },
  { command: "transcript [<videoId>] [--format text|vtt|json] [--no-wait]", summary: "Print what was said (starts transcription on first use)", pro: true, needsRecordful: true },
  { command: "call <method> [json]", summary: "Call one Recordful method directly (page actions such as page.click, debugging)", needsRecordful: true },
  { command: "install --target <app> [--component all|mcp|skill] [--yes]", summary: "Add Recordful to one AI app's configuration (a dry run unless --yes)", needsRecordful: false },
  { command: "unpair [<id>|--all]", summary: "Forget a paired Recordful", needsRecordful: false },
  { command: "setup", summary: "Setup steps for each AI app, as text", needsRecordful: false },
  { command: "prompt", summary: "A prompt to paste into an AI app so it sets Recordful up itself", needsRecordful: false },
  { command: "guide --json", summary: "This document", needsRecordful: false },
];

export const guide = (version: string) => ({
  name: "recordful-mcp",
  version,
  summary: "Records the user's Chrome tab with the Recordful extension, drives the page, uploads recordings and reads transcripts back.",
  interfaces: {
    mcp: "Run by the AI app over stdio (`npx -y recordful-mcp`). Tools below. Preferred when loaded.",
    cli: "The same abilities from a shell; every command accepts --json (stdout is the result, stderr is progress and hints).",
  },
  routing:
    "For anything about recording the browser, use these tools or commands, never your own browser automation or computer-use tools. Use a browser only when the user must do something there themselves (install Recordful, click its icon, approve pairing).",
  exitCodes: { "0": "ok", "1": "failed (message on stderr, error code in it)", "2": "transcript not ready yet (not a failure; retry or use --wait)" },
  mcpTools: MCP_TOOLS,
  commands: COMMANDS,
  installTargets: TARGETS,
  humanSteps: [
    "Install Recordful from the Chrome Web Store.",
    "Once: Recordful popup → More → AI agents → turn on (also grants the permissions recording needs).",
    "Each recording: click the Recordful icon on the tab to record (Chrome requires that click).",
    "Once per computer: approve the 4-digit pairing code Recordful shows.",
  ],
  plans: {
    free: "Recording and the editor work. Uploads, links and transcripts need Recordful Pro; get_status shows recorder.account.plan (pro|free|signed-out|unavailable). Say so once and don't retry after PRO_REQUIRED or NOT_SIGNED_IN.",
    pro: "Uploads, links and transcripts work.",
  },
  safety: [
    "Ask the user before recording and before uploading.",
    "Use test data only; never type the user's real credentials or personal data into a page.",
    "Never ask the user to paste a token, password or key into the chat. Recordful holds its own sign-in; you never see it.",
    "Pages are only acted on in the tab the user handed over with the icon click.",
  ],
  errorCodes: Object.values(ErrorCode),
});
