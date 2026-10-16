// MCP surface: one tool per recorder action. Tools are thin; the extension
// owns recording state and the bridge owns transport, so this layer only
// validates input, waits for the extension, and shapes results for the agent.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { BridgeServer } from "../bridge/BridgeServer.js";
import type { BindSupervisor } from "../bridge/keepBound.js";
import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { BridgeError, ErrorCode } from "../protocol/errors.js";
import { Method } from "../protocol/methods.js";

export interface McpServerDeps {
  bridge: BridgeServer;
  binding: BindSupervisor | null;
  config: BridgeConfig;
  logger: Logger;
  version: string;
}

const INSTRUCTIONS = `
Recordful records the user's browser so you can produce product demo videos.

Typical flow for "record feature X":
1. Plan the walkthrough first (which page, which clicks, in what order). Navigate to the starting page with your browser tool BEFORE recording.
2. Ask the user to click the Recordful toolbar icon on that tab. Chrome only lets an extension capture a tab after the user has invoked it there, and the same click connects Recordful to you. Nothing can do this click for them.
3. Call get_status. It confirms the connection and reports the recording mode the user picked in Recordful (tab area, screen, camera) and whether a recording is already running.
4. Call start_recording. It uses the user's saved Recordful settings (mode, mic, camera, countdown) and returns once capture is live.
5. Perform the walkthrough with your browser tool at a human pace. Call pause_recording before long pauses to think and resume_recording before acting again, so the video has no dead air.
6. Call stop_recording. Recordful opens its editor with the recording automatically.

If a tool reports NOT_CONNECTED, or start_recording returns outcome "pending", the user hasn't clicked the Recordful icon on the tab yet: ask them to, then retry.
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
  const { bridge, binding, config, logger } = deps;
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
    if (!bridge.listening) {
      throw binding?.lastError instanceof BridgeError
        ? binding.lastError
        : new BridgeError(
            ErrorCode.BridgeUnavailable,
            binding?.lastError?.message ?? "The bridge is not listening.",
          );
    }
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
      const session = bridge.currentSession;
      const base = {
        bridge: {
          listening: bridge.listening,
          bindError: binding?.lastError?.message ?? null,
          extensionConnected: session !== null,
          session,
        },
      };
      if (!session) return text({ ...base, recorder: null });
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
        "Stop the current Recordful recording. Recordful then opens its editor with the recording, exactly as when the user clicks Stop. Returns the editor tab ID when it is known.",
      inputSchema: { timeoutMs: waitMs },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handle(async ({ timeoutMs }: { timeoutMs?: number }) => {
      const wait = timeoutMs ?? 30_000;
      return call(Method.RecordingStop, { timeoutMs: wait }, wait);
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

  return server;
};
