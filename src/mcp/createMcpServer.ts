// The local MCP server: the transport-agnostic core (src/core) over the
// loopback bridge, with the text that fits an AI app on this computer
// (pairing codes, AI agents switch, localhost apps). cli.ts and the tests use
// this; the hosted server builds the same core with its own transport and copy.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge/BridgeServer.js";
import type { BridgeConfig } from "../config.js";
import { createRecordfulServer } from "../core/createRecordfulServer.js";
import type { Logger } from "../logger.js";
import { localTransport } from "./localTransport.js";

export interface McpServerDeps {
  bridge: Bridge;
  config: BridgeConfig;
  logger: Logger;
  version: string;
}

const INSTRUCTIONS = `
Recordful records the user's browser so you can produce product demo videos. It also drives the page it records, so you don't need a browser tool of your own.

Typical flow for "record feature X" (the record_feature prompt has the full version):
1. Plan the walkthrough first: which page, which clicks, what to type, in what order. Use test data only, never the user's real credentials.
2. Ask the user to click the Recordful toolbar icon in Chrome on the tab to record. Chrome only lets an extension capture a tab after the user has invoked it there, and the same click connects Recordful to you. Nothing can do this click for them. Page tools only ever act on that tab.
3. Call get_status. It confirms the connection, shows the tab you were handed (recorder.agent.armedTab), and reports the recording mode the user picked in Recordful (tab area, screen, camera) and whether a recording is already running.
4. Get to the starting page before recording: navigate(url), then snapshot() to check it loaded.
5. Call start_recording. It uses the user's saved Recordful settings (mode, mic, camera, countdown) and returns once capture is live.
6. Walk through the feature with the page tools: snapshot() lists the interactive elements with refs ("e12"), then click(ref), type(ref, text), press(key), scroll(...), wait_for(...). Recordful moves a visible cursor to each target and types at a human pace, so the video looks like a person using the app. Take a fresh snapshot after anything that changes the page; refs from before a navigation stop working.
7. Call pause_recording before you stop to think or plan the next steps, and resume_recording right before acting again, so the video has no dead air. snapshot and screenshot work while paused.
8. Call stop_recording. Recordful opens its editor with the recording automatically.
9. To share it or read it back (Recordful Pro): stop_recording says where the recording went. A cloud recording is already uploading; a local one uploads with upload_recording. get_video gives its links once it's ready, and get_transcript returns what was said (it transcribes on first use and waits).

Free and Pro:
- Every plan: recording, page tools, and Recordful's editor (the video is saved on this computer and opens there).
- Recordful Pro only: uploads, cloud videos (list_videos, get_video) and transcripts (get_transcript).
- get_status shows recorder.account.plan: "pro", "free", "signed-out", or "unavailable". Check it before you promise a link or a transcript. If it isn't "pro", record as usual, tell the user the video is open in Recordful's editor, and mention once that links and transcripts come with Recordful Pro (recordful.app/upgrade). Don't call upload_recording or get_transcript, and don't retry them after PRO_REQUIRED or NOT_SIGNED_IN.

First connection on a computer:
- NOT_CONNECTED: ask the user to click the Recordful icon. If that doesn't connect, they need to turn on AI agents in Recordful once (Recordful popup → More → AI agents, or paste chrome-extension://hkcgjbkibidgbefehehenlmhjanjaopc/agents.html into Chrome's address bar).
- PAIRING_PENDING: Recordful opened a window asking the user to approve you. Tell them the 4-digit code from the error so they can check it matches, ask them to click Allow, then retry. This happens once per computer.
- PAIRING_DENIED: the user declined. Don't retry unless they ask.
- PERMISSIONS_NEEDED: Recordful's one-time browser permission to record hasn't been granted. Tell the user to turn AI agents off and on again in Recordful (popup → More → AI agents) and click Allow, then retry.
- NOT_ARMED, or start_recording returning outcome "pending": the user hasn't clicked the Recordful icon on that tab yet. Ask them to, then retry.
- NOT_SIGNED_IN or PRO_REQUIRED: uploads and transcripts need the user signed in to Recordful Pro. Relay the error's message (it says what still works); don't retry.

If you have a browser tool of your own you can use it for the walkthrough instead, but Recordful's page tools make smoother videos.
"screen" mode always shows Chrome's screen picker, which the user must answer.
`.trim();

export const recordFeaturePrompt = (feature: string, url?: string): string => `Record a product demo video of this feature with Recordful: ${feature}

1. Understand it as a user sees it. If you or the user just built it, read the changes (git diff, recent commits, routes, pages, components). List the screens and moments worth showing: the main path first, then at most one or two telling states (for example a validation error). Leave out internals.
2. Get the app running. ${url ? `It should be at ${url}.` :"If it's a local project, find how to run it (package.json scripts, README, Makefile, docker compose) and the URL it serves."} If it isn't running, start it in the background and wait until it answers.
3. Prepare test data. Use test accounts and data only: from seed, fixture or example-config files, or create a new one through the app itself (for example sign up as demo+<timestamp>@example.com with a generated password). Never type the user's real credentials or personal data; if real credentials are unavoidable, ask the user to sign in themselves first.
4. Write a short shot list, 5 to 10 steps for a 30 to 90 second video: the starting screen, the main action, the result, an optional second state, and a clear final screen. Share it with the user in a line or two, then go ahead unless something is unclear.
5. Ask the user to click the Recordful icon in Chrome on the tab with the app. The first time only, they also turn on AI agents (Recordful popup → More → AI agents), and approve the pairing code you'll get back. Then call get_status, and note recorder.account.plan: links and transcripts need "pro".
6. navigate to the starting page and snapshot it. Make sure the starting state is clean (signed out for a sign-in demo, no leftover data or open dialogs).
7. start_recording, then follow the shot list with the page tools at a calm pace. Use wait_for so each result is visible before you move on. Call pause_recording whenever you need to think, and resume_recording right before the next action, so the video has no dead air.
8. If something goes wrong while recording (an error, the wrong page), pause, fix it, and resume. Stop and start over only if the mistake would confuse viewers.
9. stop_recording. Recordful opens its editor with the video. Tell the user it's ready and summarise what the video shows in one or two sentences.
10. If the plan is "pro" and the user wants to share it or check what was said: upload_recording (a cloud recording is already uploading), then get_transcript. On any other plan, don't attempt these; say once that shareable links and transcripts come with Recordful Pro.`;

export const createMcpServer = (deps: McpServerDeps): McpServer =>
  createRecordfulServer({
    transport: localTransport(deps.bridge),
    copy: { instructions: INSTRUCTIONS, recordFeaturePrompt },
    timeouts: deps.config,
    logger: deps.logger,
    version: deps.version,
  });
