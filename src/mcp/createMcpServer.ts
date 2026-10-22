// MCP surface: one tool per recorder action. Tools are thin; the extension
// owns recording state and the bridge owns transport, so this layer only
// validates input, waits for the extension, and shapes results for the agent.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Bridge } from "../bridge/BridgeServer.js";
import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { BridgeError, ErrorCode } from "../protocol/errors.js";
import { Method } from "../protocol/methods.js";
import { pageExtraWaitMs, pageParams, parsePageParams, type PageMethod } from "../protocol/page.js";
import { registerVideoTools } from "./videoTools.js";

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
- NOT_ARMED, or start_recording returning outcome "pending": the user hasn't clicked the Recordful icon on that tab yet. Ask them to, then retry.
- NOT_SIGNED_IN or PRO_REQUIRED: uploads and transcripts need the user signed in to Recordful Pro. Relay the error's message (it says what still works); don't retry.

If you have a browser tool of your own you can use it for the walkthrough instead, but Recordful's page tools make smoother videos.
"screen" mode always shows Chrome's screen picker, which the user must answer.
`.trim();

const text = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const failure = (err: unknown): CallToolResult => {
  const e =
    err instanceof BridgeError
      ? err
      : new BridgeError(ErrorCode.Internal, err instanceof Error ? err.message : String(err));
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: { code: e.code, message: e.message, data: e.data } }, null, 2),
      },
    ],
  };
};

// Upper bound on how long the extension may spend inside a recording call.
const waitMs = z
  .number()
  .int()
  .min(1_000)
  .max(120_000)
  .optional()
  .describe("Maximum time to wait for the recorder to reach the new state, in milliseconds.");

const tabId = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe("Chrome tab ID to target. Defaults to the active tab of the last focused window.");

export const createMcpServer = (deps: McpServerDeps): McpServer => {
  const { bridge, config, logger } = deps;
  const log = logger.child({ component: "mcp" });

  const server = new McpServer(
    { name: "recordful", title: "Recordful", version: deps.version },
    { instructions: INSTRUCTIONS },
  );

  // Every call waits briefly for the extension: Chrome idles service workers,
  // and a cold one needs a moment to wake and dial back in.
  const call = async (
    method: string,
    params: Record<string, unknown>,
    extraWaitMs = 0,
  ): Promise<unknown> => {
    await bridge.waitForSession(config.connectWaitMs);
    const started = Date.now();
    try {
      return await bridge.request(method, params, config.requestTimeoutMs + extraWaitMs);
    } finally {
      log.info("tool call", { method, ms: Date.now() - started });
    }
  };

  const handle =
    <A>(fn: (args: A) => Promise<unknown>) =>
    async (args: A): Promise<CallToolResult> => {
      try {
        return text(await fn(args));
      } catch (err) {
        return failure(err);
      }
    };

  server.registerTool(
    "get_status",
    {
      title: "Get recorder status",
      description:
        "Report whether the Recordful extension is connected and what the recorder is doing (idle, starting, recording, paused), the selected recording mode, the active tab, and which capture permissions are granted. Safe to call any time.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const { session, pairing } = await bridge.state();
      const { mode, error } = bridge.connection;
      const base = {
        bridge: {
          // owner: this process holds Recordful's connection; peer: it shares
          // another recordful-mcp's (another AI app or the CLI started first).
          mode,
          error,
          extensionConnected: session !== null,
          session,
          pairing: pairing ? { code: pairing.code, app: pairing.app, startedAt: pairing.startedAt } : null,
        },
      };
      if (!session) {
        return text({
          ...base,
          recorder: null,
          hint: pairing
            ? `Recordful is waiting for the user to approve this app. Ask them to check the code ${pairing.code} and click Allow.`
            : "Ask the user to click the Recordful toolbar icon in Chrome on the tab to record. The first time only, they also turn on AI agents (Recordful popup → More → AI agents).",
        });
      }
      try {
        return text({ ...base, recorder: await call(Method.StatusGet, {}) });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "start_recording",
    {
      title: "Start recording",
      description:
        "Start a Recordful recording on the target tab using the user's saved Recordful settings (mode, microphone, camera, countdown). Resolves once capture is live, or reports why it could not start. Navigate to the page you want to show before calling this.",
      inputSchema: { tabId, timeoutMs: waitMs },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handle(async ({ tabId, timeoutMs }: { tabId?: number; timeoutMs?: number }) => {
      const wait = timeoutMs ?? 30_000;
      return call(Method.RecordingStart, { tabId, timeoutMs: wait }, wait);
    }),
  );

  server.registerTool(
    "stop_recording",
    {
      title: "Stop recording",
      description:
        'Stop the current Recordful recording. Recordful then opens its editor with the recording, exactly as when the user clicks Stop. Returns where it went: recording.kind "cloud" (Recordful Pro: already uploading, with its videoId and links) or "local" (saved on this computer as takeId; upload_recording uploads it).',
      inputSchema: { timeoutMs: waitMs },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handle(async ({ timeoutMs }: { timeoutMs?: number }) => {
      const wait = timeoutMs ?? 30_000;
      // After stopping, a local recording is written out (up to 20 s) and the
      // editor opens (up to 15 s) before the extension answers.
      return call(Method.RecordingStop, { timeoutMs: wait }, wait + 40_000);
    }),
  );

  server.registerTool(
    "pause_recording",
    {
      title: "Pause recording",
      description:
        "Pause the current recording. Use it while you plan the next step so the video has no dead air. No-op if already paused.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async () => call(Method.RecordingPause, {}, 10_000)),
  );

  server.registerTool(
    "resume_recording",
    {
      title: "Resume recording",
      description: "Resume a paused recording. No-op if not paused.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handle(async () => call(Method.RecordingResume, {}, 10_000)),
  );

  server.registerTool(
    "probe_capture",
    {
      title: "Probe capture permissions",
      description:
        "Diagnostic: check, without recording, whether the extension can capture the target tab right now with no user click, and which optional Chrome permissions are granted. Refuses while a recording is running.",
      inputSchema: { tabId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle(async ({ tabId }: { tabId?: number }) => call(Method.CaptureProbe, { tabId })),
  );

  // ---- page tools ----------------------------------------------------------
  // The extension performs these in the tab the user handed it, so agents
  // without a browser tool can do the walkthrough themselves.

  const pageCall = async (method: PageMethod, args: unknown): Promise<unknown> => {
    const params = parsePageParams(method, args) as Record<string, unknown>;
    try {
      return await call(method, params, pageExtraWaitMs(method, params));
    } catch (err) {
      if (err instanceof BridgeError && err.code === ErrorCode.UnknownMethod) {
        throw new BridgeError(err.code, err.message, {
          hint: "This version of Recordful predates page tools. Ask the user to update Recordful (chrome://extensions → Update) and try again.",
        });
      }
      throw err;
    }
  };

  const pageTool = (
    name: string,
    method: PageMethod,
    title: string,
    description: string,
    annotations: { readOnlyHint: boolean },
  ) =>
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: pageParams[method],
        annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true, ...annotations },
      },
      handle(async (args: unknown) => pageCall(method, args)),
    );

  pageTool(
    "navigate",
    Method.PageNavigate,
    "Open a URL",
    "Open an http(s) URL in the tab the user handed to Recordful and wait for it to load. Returns the final URL and title. Refs from earlier snapshots stop working.",
    { readOnlyHint: false },
  );

  pageTool(
    "snapshot",
    Method.PageSnapshot,
    "List page elements",
    "List the interactive elements (links, buttons, fields, checkboxes, tabs, menu items) and headings in the recorded tab, each with a ref to pass to click/type/scroll/wait_for, its role, accessible name, current value or state, and bounding box in CSS pixels. Refs stay the same for an element while it stays on the page.",
    { readOnlyHint: true },
  );

  pageTool(
    "click",
    Method.PageClick,
    "Click an element",
    "Move Recordful's visible cursor to the element, scrolling it into view if needed, and click it, with a click highlight in the video. Reports a navigation the click started. Fails with ELEMENT_OBSCURED (naming what is on top, with its ref) if something covers it.",
    { readOnlyHint: false },
  );

  pageTool(
    "type",
    Method.PageType,
    "Type into a field",
    "Click the field, then type the text at a human pace (text inputs, text areas, content-editable areas). Set clear to replace what is already there. Use press for Enter, Tab and other keys.",
    { readOnlyHint: false },
  );

  pageTool(
    "press",
    Method.PagePress,
    "Press a key",
    "Press a key in the focused element, e.g. Enter to submit a form, Tab to move focus, Escape to close a dialog, ArrowDown in a menu, Shift+Tab, Control+a. Recordful also performs the key's usual effect (submitting, moving focus, deleting), since pages ignore synthetic keys otherwise.",
    { readOnlyHint: false },
  );

  pageTool(
    "scroll",
    Method.PageScroll,
    "Scroll",
    "Scroll smoothly: either bring an element (ref) into view, or scroll the page in a direction, by amount pixels or most of a screen.",
    { readOnlyHint: false },
  );

  pageTool(
    "wait_for",
    Method.PageWaitFor,
    "Wait for the page",
    'Wait until text appears on the page or an element (ref) becomes visible, or with state "hidden" until it goes away. Keeps waiting across navigations. Fails with WAIT_TIMEOUT if it doesn\'t happen in time.',
    { readOnlyHint: true },
  );

  server.registerTool(
    "screenshot",
    {
      title: "Screenshot the page",
      description:
        "Capture what the recorded tab shows right now, as an image, to check the page looks right. The tab must be the active tab of its window.",
      inputSchema: pageParams[Method.PageScreenshot],
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args: unknown): Promise<CallToolResult> => {
      try {
        const shot = (await pageCall(Method.PageScreenshot, args)) as Record<string, unknown> | null;
        const { data, mimeType, ...meta } = shot ?? {};
        if (typeof data !== "string" || typeof mimeType !== "string") {
          throw new BridgeError(ErrorCode.Internal, "The extension returned no image.");
        }
        return {
          content: [
            { type: "image", data, mimeType },
            { type: "text", text: JSON.stringify(meta, null, 2) },
          ],
        };
      } catch (err) {
        return failure(err);
      }
    },
  );

  // ---- recordings: upload, videos, transcripts ------------------------------

  registerVideoTools(server, call, async (fn) => {
    try {
      return text(await fn());
    } catch (err) {
      return failure(err);
    }
  });

  // ---- prompts -------------------------------------------------------------
  // The whole "record the feature I just built" workflow, shipped with the
  // server so every MCP client gets it (Claude Code lists it as
  // /mcp__recordful__record_feature).

  server.registerPrompt(
    "record_feature",
    {
      title: "Record a feature demo",
      description:
        "Plan and record a short product demo of a feature with Recordful: work out the user-facing flow, get the app running with test data, record a clean walkthrough, and open it in the editor.",
      argsSchema: {
        feature: z.string().describe("The feature to show, e.g. \"sign up and sign in\" or \"the new billing page\"."),
        url: z
          .string()
          .optional()
          .describe("Where the app runs, e.g. http://localhost:3000. Leave empty to work it out from the project."),
      },
    },
    ({ feature, url }) => ({
      messages: [{ role: "user", content: { type: "text", text: recordFeaturePrompt(feature, url) } }],
    }),
  );

  return server;
};

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
