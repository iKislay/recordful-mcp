#!/usr/bin/env node
// recordful-mcp: the MCP server (default) and a CLI for agents and people who
// prefer a shell: record, upload, list videos, read transcripts back.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { intFlag, parseArgs, type Parsed } from "./args.js";
import { PairingStore } from "./auth/pairings.js";
import { BridgeAgent } from "./bridge/BridgeAgent.js";
import { appDisplayName } from "./clientNames.js";
import { loadConfig, type BridgeConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { guide } from "./guide.js";
import { COMPONENTS, install, isComponent, isTarget, TARGET_NAMES, TARGETS } from "./install.js";
import { createMcpServer } from "./mcp/createMcpServer.js";
import { BridgeError, ErrorCode } from "./protocol/errors.js";
import { isMethod, Method, METHODS } from "./protocol/methods.js";
import { isPageMethod, pageExtraWaitMs, parsePageParams } from "./protocol/page.js";
import { parseVideoParams, VISIBILITIES, videoParams } from "./protocol/video.js";
import { setupGuide } from "./setupGuide.js";
import { SETUP_PROMPT } from "./setupPrompt.js";
import { getVideoAndWait, mb, transcriptAndWait, uploadAndWait, type Call } from "./workflows.js";
import { desktopCall } from "./desktop.js";
import { registerNativeHost, runNativeHost } from "./nativeHost.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const HELP = `recordful-mcp ${version}: let any AI app record, upload and read back product demos with Recordful

Usage:
  recordful-mcp                        Run the MCP server on stdio (what AI apps start)
  recordful-mcp install --target <app> [--component all|mcp|skill] [--yes] [--json]
                                       Add Recordful (server + skill) to one AI app's own configuration.
                                       <app>: ${TARGETS.join(", ")}. Without --yes it only shows what it would change.
  recordful-mcp setup                  Setup steps for every AI app, as text
  recordful-mcp prompt                 A prompt to paste into any AI app so it sets Recordful up itself
  recordful-mcp guide --json           Everything an AI agent needs to know about this install

Recording (click the Recordful icon on the tab first):
  recordful-mcp start [--tab <id>]     Start recording with your Recordful settings
  recordful-mcp pause | resume         Pause or resume
  recordful-mcp stop                   Stop; says where the recording went
  recordful-mcp screenshot [--page] [--look 3d|<preset>]
                                       Screenshot the tab and open it in Recordful's screenshot editor

Desktop screenshots (Recordful desktop app, Settings → AI agents turned on):
  recordful-mcp screenshot --source screen [--display 1] [--look 3d]
  recordful-mcp screenshot --source window --window <name>
  recordful-mcp screenshot --source area
                                       Screenshot the desktop and open it in the app's editor
  recordful-mcp windows                The desktop's open windows

Videos (uploads and transcripts need Recordful Pro):
  recordful-mcp recordings             Recordings saved on this computer
  recordful-mcp upload [<takeId>]      Upload a recording (default: the last one)
        [--title <t>] [--visibility private|workspace|public] [--force] [--no-wait]
  recordful-mcp videos [--limit <n>] [--query <text>]
                                       Your videos on recordful.app
  recordful-mcp video [<videoId>] [--wait]
                                       One video's links and upload stage
  recordful-mcp transcript [<videoId>] [--format text|vtt|json] [--query <words>] [--no-wait]
  recordful-mcp summary [<videoId>] [--generate | --regenerate]
                                       AI summary and chapters (--generate spends AI credits)
                                       Print what was said (transcribes on first use)

Manage videos, comments and folders (Recordful Pro; change things only when the user asked):
  recordful-mcp update [<videoId>] [--title <t>] [--visibility private|workspace|public]
                     [--password-stdin | --no-password] [--expires <ISO time> | --no-expiry]
  recordful-mcp delete <videoId> --dry-run  What would be deleted; changes nothing
  recordful-mcp delete <videoId> --yes      To trash for 7 days; --yes confirms this exact video
  recordful-mcp trash                       Deleted videos
  recordful-mcp restore <videoId>           Bring one back out of trash
  recordful-mcp activity [<videoId>] [--days n]   Views (where from, per day), likes, comments
  recordful-mcp analytics [--days n]        Views across all videos, most viewed
  recordful-mcp comment [<videoId>] --body <text>
  recordful-mcp comment-delete <videoId> <commentId> --yes
  recordful-mcp like [<videoId>] [--undo]
  recordful-mcp folders                     Your folders
  recordful-mcp folder-create <name> [--parent <folderId>]
  recordful-mcp move <videoId>... [--to <folderId>]   (no --to: the top level)
  recordful-mcp storage                     Cloud storage used

Other:
  recordful-mcp status                 Connection, recorder and pairing state
  recordful-mcp unpair [<id>|--all]    Forget a paired Recordful (or all of them)
  recordful-mcp call <method> [json]   Call one Recordful method directly (debugging)
  recordful-mcp --version | --help

Add --json to any command for machine-readable output. Progress goes to stderr.
Without a video or recording ID, commands use the last recording.

Environment (all optional): RECORDFUL_BRIDGE_PORT, RECORDFUL_BRIDGE_ALLOWED_EXTENSION_IDS,
RECORDFUL_BRIDGE_STATE_PATH, RECORDFUL_BRIDGE_TOKEN, RECORDFUL_BRIDGE_LOG_LEVEL. See docs/reference.md.
`;

// How long the background helper stays up with nothing asking it anything
// (RECORDFUL_BRIDGE_HELPER_IDLE_MS overrides it, for tests).
const DAEMON_IDLE_MS = Number(process.env.RECORDFUL_BRIDGE_HELPER_IDLE_MS) || 30 * 60_000;
// How long a command waits for Recordful to connect (the user clicks its icon).
const CLI_CONNECT_MS = 120_000;

const openStore = (config: BridgeConfig) =>
  PairingStore.open({ path: config.statePath, envSecret: config.envSecret });

// ---- output ------------------------------------------------------------------

const out = (line = "") => process.stdout.write(`${line}\n`);

const readStdin = async () => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};
const note = (line: string) => process.stderr.write(`${line}\n`);

type DailyViews = Array<{ date: string; views: number }> | null;

// Only the days someone watched, so a quiet month stays short.
const printDaily = (daily: DailyViews | undefined) => {
  const busy = (daily ?? []).filter((day) => day.views > 0);
  if (busy.length) out(`  Per day: ${busy.map((day) => `${day.date} ${day.views}`).join(", ")}`);
};

const show = (json: boolean, value: unknown, human: () => void) => {
  if (json) out(JSON.stringify(value, null, 2));
  else human();
};

// ---- server and helper -------------------------------------------------------

// So Recordful can connect by itself whenever this bridge is up (nativeHost.ts).
const registerRelay = (config: BridgeConfig, logger: Logger) => {
  try {
    const where = registerNativeHost({ extensionIds: config.allowedExtensionIds, cliPath: process.argv[1] ?? "" });
    logger.debug("native host registered", { where });
  } catch (err) {
    logger.warn("could not register the native host; the Recordful icon click still connects", { error: String(err) });
  }
};

const serve = async (config: BridgeConfig, logger: Logger) => {
  const pairings = await openStore(config);
  logger.info("pairing state loaded", { path: pairings.path, serverId: pairings.serverId });
  warnOpenAllowlist(config, logger);
  registerRelay(config, logger);

  const bridge = new BridgeAgent({ config, pairings, logger });
  void bridge.start();
  const mcp = createMcpServer({ bridge, config, logger, version });

  // Recordful's pairing window names the app asking ("Claude Code wants to
  // control Recordful"), taken from the MCP client's own introduction.
  mcp.server.oninitialized = () => {
    const client = mcp.server.getClientVersion();
    if (client) bridge.setAppName(appDisplayName(client));
  };

  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { reason });
    await Promise.allSettled([mcp.close(), bridge.stop()]);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // The MCP client closing our stdin is how most clients say goodbye.
  process.stdin.on("close", () => void shutdown("stdin closed"));

  await mcp.connect(new StdioServerTransport());
  logger.info("mcp server ready", { version });
};

// Keeps Recordful's connection between CLI commands, so the user clicks the
// icon once rather than before every command. Exits when idle, or at once if
// another recordful-mcp already holds the connection.
const daemon = async (config: BridgeConfig, logger: Logger) => {
  const pairings = await openStore(config);
  registerRelay(config, logger);
  const bridge = new BridgeAgent({ config, pairings, logger, app: "recordful-mcp (command line)" });
  await bridge.start();
  const server = bridge.server;
  if (!server) {
    await bridge.stop();
    return;
  }
  const timer = setInterval(() => {
    if (server.peerCount === 0 && Date.now() - server.lastPeerActivityAt > DAEMON_IDLE_MS) {
      clearInterval(timer);
      void bridge.stop().then(() => process.exit(0));
    }
  }, Math.min(60_000, DAEMON_IDLE_MS));
  const quit = () => void bridge.stop().then(() => process.exit(0));
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
};

const startDaemon = () => {
  // The same script and loader flags this command runs with (tsx in development).
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1] as string, "daemon"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.unref();
};

const warnOpenAllowlist = (config: BridgeConfig, logger: Logger) => {
  if (config.allowedExtensionIds.length === 0) {
    logger.warn("RECORDFUL_BRIDGE_ALLOWED_EXTENSION_IDS=* lets any extension connect and ask to pair. Use it for development only.");
  }
};

// A CLI command joins the running recordful-mcp (an AI app's, or the helper),
// starting the helper if none runs.
const joinBridge = async (config: BridgeConfig, logger: Logger): Promise<BridgeAgent> => {
  const pairings = await openStore(config);
  const bridge = new BridgeAgent({ config, pairings, logger, mayOwn: false, app: "recordful-mcp (command line)" });
  // Read fresh each time: the mode changes as the agent connects.
  const joined = () => bridge.connection.mode === "peer";
  await bridge.start();
  if (joined()) return bridge;
  if (bridge.lastErrorCode !== "NO_OWNER") {
    await bridge.stop();
    throw new BridgeError(ErrorCode.BridgeUnavailable, bridge.connection.error ?? "couldn't reach recordful-mcp");
  }
  startDaemon();
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await bridge.start();
    if (joined()) return bridge;
  }
  await bridge.stop();
  throw new BridgeError(ErrorCode.BridgeUnavailable, "the recordful-mcp helper didn't start; run `recordful-mcp status` for details");
};

// Waits for Recordful itself, telling the user what to do once.
const connect = async (bridge: BridgeAgent, quiet: boolean): Promise<void> => {
  const deadline = Date.now() + CLI_CONNECT_MS;
  let told = "";
  for (;;) {
    try {
      await bridge.waitForSession(Math.min(10_000, Math.max(1_000, deadline - Date.now())));
      return;
    } catch (err) {
      if (!(err instanceof BridgeError) || Date.now() >= deadline) throw err;
      const tell =
        err.code === ErrorCode.PairingPending
          ? `Recordful asks you to approve this computer: check that it shows ${(err.data as { code?: string })?.code ?? "the same code"}, then click Allow.`
          : err.code === ErrorCode.NotConnected
            ? "Click the Recordful icon in Chrome to connect (first time: Recordful popup → More → AI agents → on)…"
            : "";
      if (!tell) throw err;
      if (tell !== told && !quiet) note(tell);
      told = tell;
    }
  }
};

const withRecordful = async <T>(
  config: BridgeConfig,
  logger: Logger,
  quiet: boolean,
  fn: (call: Call) => Promise<T>,
): Promise<T> => {
  const bridge = await joinBridge(config, logger);
  try {
    await connect(bridge, quiet);
    const call: Call = (method, params, extra = 0) => bridge.request(method, params, config.requestTimeoutMs + extra);
    return await fn(call);
  } finally {
    await bridge.stop();
  }
};

// ---- commands ----------------------------------------------------------------

const statusCommand = async (config: BridgeConfig, logger: Logger, json: boolean) => {
  const pairings = await openStore(config);
  const paired = await pairings.list();
  const bridge = new BridgeAgent({ config, pairings, logger, mayOwn: false });
  await bridge.start();
  const running = bridge.connection.mode === "peer";
  let session = null;
  let recorder: Record<string, unknown> | null = null;
  if (running) {
    ({ session } = await bridge.state());
    if (session) recorder = (await bridge.request(Method.StatusGet, {}, config.requestTimeoutMs).catch(() => null)) as Record<string, unknown> | null;
  }
  await bridge.stop();
  const value = { version, port: config.port, pairingFile: pairings.path, running, extensionConnected: Boolean(session), recorder, paired };
  show(json, value, () => {
    out(`recordful-mcp ${version}`);
    out(`recordful-mcp running:  ${running ? "yes" : "no (it starts when an AI app or a command needs it)"}`);
    out(`Recordful connected:    ${session ? "yes" : "no (click the Recordful icon in Chrome)"}`);
    if (recorder) {
      const account = recorder.account as { signedIn?: boolean; pro?: boolean; email?: string | null; cloud?: boolean } | null;
      out(`Recorder:               ${recorder.state}${recorder.recordingType ? ` (${recorder.recordingType})` : ""}`);
      out(
        `Account:                ${
          account?.cloud === false
            ? "this build of Recordful has no cloud features"
            : account?.signedIn
              ? `${account.email ?? "signed in"}, ${account.pro ? "Pro" : "free plan (uploads and transcripts need Recordful Pro: recordful.app/upgrade)"}`
              : "not signed in (recording works; uploads and transcripts need a Recordful Pro account)"
        }`,
      );
    }
    out(`Pairing file:           ${pairings.path}`);
    out(paired.length ? "Paired Recordful:" : "Paired Recordful:       none yet (happens the first time an AI app connects)");
    for (const p of paired) out(`  ${p.extensionId}  first paired by ${p.app}, ${p.pairedAt}`);
  });
};

const installCommand = (args: string[]) => {
  const { flags } = parseArgs(args);
  const json = flags.json === true;
  const target = flags.target;
  if (!isTarget(target)) {
    throw new BridgeError(ErrorCode.InvalidParams, `install needs --target <app>, one of: ${TARGETS.join(", ")}`);
  }
  const component = flags.component ?? "all";
  if (!isComponent(component)) {
    throw new BridgeError(ErrorCode.InvalidParams, `--component must be one of: ${COMPONENTS.join(", ")}`);
  }
  const result = install(target, { apply: flags.yes === true, component });
  show(json, result, () => {
    out(`${result.applied ? "Added Recordful to" : "Would add Recordful to"} ${TARGET_NAMES[target]}:`);
    for (const c of result.changes) {
      const where = c.path ?? c.command ?? "";
      const done = result.applied;
      const verb: Record<string, string> = {
        unchanged: "already set up",
        manual: "needs you",
        run: done ? "ran" : "would run",
        create: done ? "created" : "would create",
        update: done ? "updated" : "would update",
      };
      out(`  ${c.component === "mcp" ? "MCP server" : "Skill     "}  ${verb[c.action]}  ${where}`);
      if (c.detail) out(`    ${c.detail.split("\n").join("\n    ")}`);
    }
    if (!result.applied) out("Nothing was written. Add --yes to apply.");
    else out(result.restart);
  });
};

const unpairCommand = async (config: BridgeConfig, args: string[]) => {
  const [target] = args;
  if (!target) throw new BridgeError(ErrorCode.InvalidParams, "unpair needs an extension ID (see `recordful-mcp status`) or --all");
  const pairings = await openStore(config);
  const removed = await pairings.remove(target === "--all" ? undefined : target);
  out(removed ? `Forgot ${removed} pairing${removed === 1 ? "" : "s"}. Recordful will ask to pair again next time.` : "Nothing to forget.");
};

const progressLine = (json: boolean) => {
  let last = "";
  return (message: string) => {
    if (json || message === last) return;
    last = message;
    note(`${message}…`);
  };
};

const runCommand = async (command: string, parsed: Parsed, config: BridgeConfig, logger: Logger) => {
  const { positional, flags } = parsed;
  const json = flags.json === true;
  const quiet = json;
  const timeoutMs = intFlag(flags, "timeout");

  switch (command) {
    case "start":
      return withRecordful(config, logger, quiet, async (call) => {
        const tab = intFlag(flags, "tab");
        const r = (await call(Method.RecordingStart, { ...(tab ? { tabId: tab } : {}), timeoutMs: 30_000 }, 30_000)) as Record<string, unknown>;
        show(json, r, () => out(r.outcome === "recording" ? `Recording${r.recordingType ? ` (${r.recordingType})` : ""}.` : `Not recording yet: ${r.hint ?? r.outcome}`));
      });
    case "stop":
      return withRecordful(config, logger, quiet, async (call) => {
        const r = (await call(Method.RecordingStop, { timeoutMs: 30_000 }, 70_000)) as {
          recording?: { kind: string; videoId?: string; viewUrl?: string; takeId?: string };
        };
        show(json, r, () => {
          const rec = r.recording;
          if (rec?.kind === "cloud") out(`Stopped. Uploading to recordful.app: ${rec.viewUrl}`);
          else if ((r as { plan?: string }).plan === "pro") out(`Stopped. Saved on this computer${rec?.takeId ? ` (${rec.takeId})` : ""}. Upload it with: recordful-mcp upload`);
          else out("Stopped. Saved on this computer and open in Recordful's editor. (Links and transcripts need Recordful Pro.)");
        });
      });
    case "pause":
    case "resume":
      return withRecordful(config, logger, quiet, async (call) => {
        const r = (await call(command === "pause" ? Method.RecordingPause : Method.RecordingResume, {}, 10_000)) as Record<string, unknown>;
        show(json, r, () => out(command === "pause" ? "Paused." : "Recording."));
      });
    case "screenshot":
      if (typeof flags.source === "string" && flags.source !== "tab") {
        const r = await desktopCall(
          "/screenshot",
          {
            method: "POST",
            body: {
              source: flags.source,
              window: typeof flags.window === "string" ? flags.window : undefined,
              display: typeof flags.display === "string" ? Number(flags.display) || "main" : undefined,
              look: typeof flags.look === "string" ? flags.look : undefined,
              agent: "recordful-mcp CLI",
            },
          },
          flags.source === "area" ? 180_000 : 30_000,
        );
        return show(json, r, () =>
          out(r.ok ? "Screenshot open in the Recordful desktop app's editor." : "Canceled."),
        );
      }
      return withRecordful(config, logger, quiet, async (call) => {
        const params = parsePageParams(Method.ShotTake, {
          ...(flags.page === true ? { mode: "page" } : {}),
          ...(typeof flags.look === "string" ? { look: flags.look } : {}),
        }) as Record<string, unknown>;
        const r = await call(Method.ShotTake, params, pageExtraWaitMs(Method.ShotTake, params));
        show(json, r, () => out("Screenshot open in Recordful's screenshot editor."));
      });
    case "windows": {
      const r = (await desktopCall("/windows")) as { windows: { app: string; title: string }[] };
      return show(json, r, () => {
        for (const w of r.windows) out(`${w.app}  ${w.title}`);
      });
    }
    case "recordings":
      return withRecordful(config, logger, quiet, async (call) => {
        const r = (await call(Method.TakesList, {})) as { takes: Array<Record<string, unknown>> };
        show(json, r, () => {
          if (!r.takes.length) return out("No recordings on this computer.");
          for (const t of r.takes) {
            out(`${t.takeId}  ${mb(t.bytes as number)}  ${t.recordedAt}${t.uploadedVideoId ? `  uploaded: ${t.uploadedVideoId}` : ""}${t.isLastRecording ? "  (last)" : ""}`);
          }
        });
      });
    case "upload":
      return withRecordful(config, logger, quiet, async (call) => {
        const visibility = flags.visibility;
        if (visibility !== undefined && !VISIBILITIES.includes(visibility as (typeof VISIBILITIES)[number])) {
          throw new BridgeError(ErrorCode.InvalidParams, `--visibility must be one of ${VISIBILITIES.join(", ")}`);
        }
        const r = await uploadAndWait(
          call,
          {
            ...(positional[0] ? { takeId: positional[0] } : {}),
            ...(typeof flags.title === "string" ? { title: flags.title } : {}),
            ...(visibility ? { visibility } : {}),
            ...(flags.force ? { force: true } : {}),
            wait: !flags["no-wait"],
            ...(timeoutMs ? { timeoutMs } : {}),
          },
          progressLine(json),
        );
        show(json, r, () => {
          out(r.stage === "uploading" ? "Upload started; it continues in the background." : "Uploaded.");
          out(`Watch: ${r.viewUrl}`);
          out(`Edit:  ${r.editUrl}`);
          if (typeof r.note === "string" && r.camera === "skipped") note(r.note);
        });
      });
    case "videos":
      return withRecordful(config, logger, quiet, async (call) => {
        const r = (await call(
          Method.VideoList,
          {
            ...(intFlag(flags, "limit") ? { limit: intFlag(flags, "limit") } : {}),
            ...(typeof flags.query === "string" ? { query: flags.query } : {}),
          },
          40_000,
        )) as { videos: Array<Record<string, unknown>> };
        show(json, r, () => {
          if (!r.videos.length) return out("No videos yet.");
          for (const v of r.videos) out(`${v.videoId}  ${v.createdAt ?? ""}  ${v.title ?? ""}\n    ${v.viewUrl}`);
        });
      });
    case "video":
      return withRecordful(config, logger, quiet, async (call) => {
        const r = await getVideoAndWait(
          call,
          { ...(positional[0] ? { videoId: positional[0] } : {}), wait: Boolean(flags.wait), ...(timeoutMs ? { timeoutMs } : {}) },
          progressLine(json),
        );
        show(json, r, () => {
          out(`${r.title ?? "Untitled"} (${r.videoId})`);
          out(`Stage: ${r.stage}${r.durationSeconds ? `, ${r.durationSeconds}s` : ""}${r.visibility ? `, ${r.visibility}` : ""}`);
          out(`Watch: ${r.viewUrl}`);
          out(`Edit:  ${r.editUrl}`);
        });
      });
    case "transcript":
      return withRecordful(config, logger, quiet, async (call) => {
        const format = flags.format ?? "text";
        if (format !== "text" && format !== "vtt" && format !== "json") {
          throw new BridgeError(ErrorCode.InvalidParams, "--format must be text, vtt or json");
        }
        const r = await transcriptAndWait(
          call,
          {
            ...(positional[0] ? { videoId: positional[0] } : {}),
            format: format === "json" ? "both" : format,
            ...(flags.query ? { query: flags.query } : {}),
            wait: !flags["no-wait"],
            ...(timeoutMs ? { timeoutMs } : {}),
          },
          progressLine(json || format === "json"),
        );
        if (json || format === "json") return out(JSON.stringify(r, null, 2));
        if (r.status !== "done") {
          note(String(r.note ?? r.status));
          process.exitCode = 2;
          return;
        }
        if (typeof r.note === "string") note(r.note);
        if (Array.isArray(r.matches)) {
          const clock = (ms: number) => new Date(ms).toISOString().slice(ms >= 3_600_000 ? 11 : 14, 19);
          return out(r.matches.map((m: { startMs: number; text: string }) => `${clock(m.startMs)}  ${m.text}`).join("\n"));
        }
        out(String(format === "vtt" ? r.vtt ?? "" : r.text ?? ""));
      });
    case "summary":
      return withRecordful(config, logger, quiet, async (call) => {
        const params = parseVideoParams(videoParams.summary, {
          ...(positional[0] ? { videoId: positional[0] } : {}),
          ...(flags.generate ? { generate: true } : {}),
          ...(flags.regenerate ? { regenerate: true } : {}),
        });
        const r = (await call(Method.VideoSummary, params, 100_000)) as {
          status: string;
          note?: string;
          summary?: string;
          chapters?: Array<{ startSeconds: number; title: string }>;
        };
        show(json, r, () => {
          if (r.status !== "done") {
            note(r.note ?? r.status);
            process.exitCode = 2;
            return;
          }
          out(r.summary);
          const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
          for (const c of r.chapters ?? []) out(`  ${clock(c.startSeconds).padStart(6)}  ${c.title}`);
        });
      });
    case "update":
      return withRecordful(config, logger, quiet, async (call) => {
        const visibility = flags.visibility;
        if (visibility !== undefined && !VISIBILITIES.includes(visibility as (typeof VISIBILITIES)[number])) {
          throw new BridgeError(ErrorCode.InvalidParams, `--visibility must be one of ${VISIBILITIES.join(", ")}`);
        }
        if (flags["password-stdin"] && flags["no-password"]) {
          throw new BridgeError(ErrorCode.InvalidParams, "Use --password-stdin or --no-password, not both");
        }
        if (typeof flags.expires === "string" && flags["no-expiry"]) {
          throw new BridgeError(ErrorCode.InvalidParams, "Use --expires or --no-expiry, not both");
        }
        // The password comes on stdin so it stays out of shell history and the process list.
        const password = flags["password-stdin"] ? (await readStdin()).replace(/\r?\n$/, "") : flags["no-password"] ? null : undefined;
        const expiresAt = typeof flags.expires === "string" ? flags.expires : flags["no-expiry"] ? null : undefined;
        const params = parseVideoParams(videoParams.update, {
          ...(positional[0] ? { videoId: positional[0] } : {}),
          ...(typeof flags.title === "string" ? { title: flags.title } : {}),
          ...(visibility ? { visibility } : {}),
          ...(password !== undefined ? { password } : {}),
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        });
        const r = (await call(Method.VideoUpdate, params, 40_000)) as Record<string, unknown>;
        show(json, r, () => {
          out(`${r.title ?? "Untitled"} (${r.videoId}), ${r.visibility}`);
          if (r.passwordProtected) out("Link needs a password outside the workspace");
          if (r.linkExpiresAt) out(`Link stops working ${r.linkExpiresAt}`);
          out(`Watch: ${r.viewUrl}`);
        });
      });
    case "delete":
      return withRecordful(config, logger, quiet, async (call) => {
        if (!positional[0]) throw new BridgeError(ErrorCode.InvalidParams, "delete needs the video ID (recordful-mcp videos lists them)");
        if (flags["dry-run"] === true) {
          const preview = (await call(Method.VideoDelete, { videoId: positional[0], dryRun: true }, 40_000)) as {
            wouldDelete: Record<string, unknown>;
            note: string;
          };
          const v = preview.wouldDelete;
          return show(json, preview, () => {
            out(`Would delete: ${v.title ?? "Untitled"} (${v.videoId}), recorded ${v.createdAt}, ${v.views} views`);
            out(`Watch: ${v.viewUrl}`);
            note(preview.note);
          });
        }
        if (flags.yes !== true) {
          throw new BridgeError(ErrorCode.InvalidParams, "Deleting moves the video to trash, and it's gone for good after 7 days. Check it is the right one, then run again with --yes.");
        }
        const r = (await call(Method.VideoDelete, { videoId: positional[0], confirm: true }, 40_000)) as Record<string, unknown>;
        show(json, r, () => out(`Moved ${r.videoId} to trash. recordful-mcp restore ${r.videoId} brings it back for 7 days.`));
      });
    case "trash":
      return withRecordful(config, logger, quiet, async (call) => {
        const r = (await call(Method.TrashList, {}, 40_000)) as { videos: Array<Record<string, unknown>> };
        show(json, r, () => {
          if (!r.videos.length) return out("Trash is empty.");
          for (const v of r.videos) out(`${v.videoId}  ${v.title ?? "Untitled"}  (gone ${String(v.purgesAt).slice(0, 10)})`);
        });
      });
    case "restore":
      return withRecordful(config, logger, quiet, async (call) => {
        if (!positional[0]) throw new BridgeError(ErrorCode.InvalidParams, "restore needs the video ID (recordful-mcp trash lists them)");
        const r = (await call(Method.VideoRestore, { videoId: positional[0] }, 40_000)) as Record<string, unknown>;
        show(json, r, () => out(`Restored ${r.videoId}. Watch: ${r.viewUrl}`));
      });
    case "activity":
      return withRecordful(config, logger, quiet, async (call) => {
        const params = parseVideoParams(videoParams.activity, {
          ...(positional[0] ? { videoId: positional[0] } : {}),
          ...(flags.days !== undefined ? { days: intFlag(flags, "days") } : {}),
        });
        const r = (await call(Method.VideoEngagement, params, 40_000)) as {
          videoId: string;
          views: number;
          likes: number;
          viewsBy?: { sources: Array<{ label: string; count: number }>; countries: Array<{ label: string; count: number }> } | null;
          daily?: DailyViews;
          comments: Array<{ author: string | null; createdAt: string; body: string }>;
        };
        const list = (rows: Array<{ label: string; count: number }>) => rows.map((x) => `${x.label} ${x.count}`).join(", ");
        show(json, r, () => {
          out(`${r.views} views, ${r.likes} likes, ${r.comments.length} comments`);
          if (r.viewsBy?.sources.length) out(`  From: ${list(r.viewsBy.sources)}`);
          if (r.viewsBy?.countries.length) out(`  Countries: ${list(r.viewsBy.countries)}`);
          printDaily(r.daily);
          for (const c of r.comments) out(`  ${c.author ?? "Someone"} (${c.createdAt}): ${c.body}`);
        });
      });
    case "analytics":
      return withRecordful(config, logger, quiet, async (call) => {
        const params = parseVideoParams(videoParams.analytics, flags.days !== undefined ? { days: intFlag(flags, "days") } : {});
        const r = (await call(Method.AnalyticsGet, params, 40_000)) as {
          days: number;
          views: number;
          daily?: DailyViews;
          topVideos: Array<{ videoId: string; title: string | null; views: number }>;
        };
        show(json, r, () => {
          out(`${r.views} views in the last ${r.days} days`);
          printDaily(r.daily);
          for (const v of r.topVideos) out(`  ${String(v.views).padStart(5)}  ${v.title ?? "Untitled"} (${v.videoId})`);
        });
      });
    case "comment":
      return withRecordful(config, logger, quiet, async (call) => {
        if (typeof flags.body !== "string") throw new BridgeError(ErrorCode.InvalidParams, "comment needs --body <text>");
        const r = (await call(
          Method.VideoComment,
          { ...(positional[0] ? { videoId: positional[0] } : {}), body: flags.body },
          40_000,
        )) as { comment: { id: string } };
        show(json, r, () => out(`Posted comment ${r.comment.id}.`));
      });
    case "comment-delete":
      return withRecordful(config, logger, quiet, async (call) => {
        if (flags.yes !== true) {
          throw new BridgeError(ErrorCode.InvalidParams, "A deleted comment can't be brought back. Check it is the right one, then run again with --yes.");
        }
        const params = parseVideoParams(videoParams.deleteComment, { videoId: positional[0], commentId: positional[1], confirm: true });
        const r = (await call(Method.VideoCommentDelete, params, 40_000)) as Record<string, unknown>;
        show(json, r, () => out(`Deleted comment ${r.commentId}.`));
      });
    case "like":
      return withRecordful(config, logger, quiet, async (call) => {
        const r = (await call(
          Method.VideoLike,
          { ...(positional[0] ? { videoId: positional[0] } : {}), liked: flags.undo !== true },
          40_000,
        )) as { liked: boolean; likes: number };
        show(json, r, () => out(`${r.liked ? "Liked" : "Like removed"}: ${r.likes} likes.`));
      });
    case "folders":
      return withRecordful(config, logger, quiet, async (call) => {
        const r = (await call(Method.FolderList, {}, 40_000)) as { folders: Array<Record<string, unknown>> };
        show(json, r, () => {
          if (!r.folders.length) return out("No folders yet.");
          for (const f of r.folders) out(`${f.folderId}  ${f.name}${f.parentId ? `  (in ${f.parentId})` : ""}${f.shared ? "  shared" : ""}`);
        });
      });
    case "folder-create":
      return withRecordful(config, logger, quiet, async (call) => {
        if (!positional[0]) throw new BridgeError(ErrorCode.InvalidParams, "folder-create needs a name");
        const r = (await call(
          Method.FolderCreate,
          { name: positional.join(" "), ...(typeof flags.parent === "string" ? { parentId: flags.parent } : {}) },
          40_000,
        )) as Record<string, unknown>;
        show(json, r, () => out(`Created ${r.name} (${r.folderId}).`));
      });
    case "move":
      return withRecordful(config, logger, quiet, async (call) => {
        if (!positional.length) throw new BridgeError(ErrorCode.InvalidParams, "move needs one or more video IDs");
        const r = (await call(
          Method.VideoMove,
          { videoIds: positional, folderId: typeof flags.to === "string" ? flags.to : null },
          40_000,
        )) as { moved: number; skipped: string[]; note?: string };
        show(json, r, () => {
          out(`Moved ${r.moved} video${r.moved === 1 ? "" : "s"}.`);
          if (r.skipped.length) note(r.note ?? `Skipped: ${r.skipped.join(", ")}`);
        });
      });
    case "storage":
      return withRecordful(config, logger, quiet, async (call) => {
        const r = (await call(Method.StorageGet, {}, 40_000)) as { usedBytes: number; limitBytes: number; usedPercent: number | null; canUpload: boolean };
        show(json, r, () => out(`${mb(r.usedBytes)} of ${mb(r.limitBytes)} used${r.usedPercent === null ? "" : ` (${r.usedPercent}%)`}; ${r.canUpload ? "uploads allowed" : "uploads blocked"}`));
      });
    case "call":
      return withRecordful(config, logger, quiet, async (call) => {
        const [method, rawParams] = positional;
        if (!method || !isMethod(method)) throw new BridgeError(ErrorCode.InvalidParams, `call needs a method: ${METHODS.join(", ")}`);
        let params: Record<string, unknown> = {};
        if (rawParams) {
          const value: unknown = JSON.parse(rawParams);
          if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw new BridgeError(ErrorCode.InvalidParams, "params must be a JSON object");
          }
          params = value as Record<string, unknown>;
        }
        if (isPageMethod(method)) params = parsePageParams(method, params) as Record<string, unknown>;
        const extra = isPageMethod(method)
          ? pageExtraWaitMs(method, params)
          : typeof params.timeoutMs === "number"
            ? params.timeoutMs + 40_000
            : 60_000;
        out(JSON.stringify(await call(method, params, extra), null, 2));
      });
    default:
      throw new BridgeError(ErrorCode.InvalidParams, `unknown command "${command}". Run recordful-mcp --help.`);
  }
};

const main = async () => {
  const [command = "serve", ...rest] = process.argv.slice(2);
  if (command === "--help" || command === "-h" || command === "help") return void process.stdout.write(HELP);
  if (command === "--version" || command === "-v") return out(version);
  // Started by Chrome; stdout belongs to Chrome's framing, so nothing else runs.
  if (command === "native-host") return runNativeHost(rest[0]);

  const config = loadConfig();
  // CLI commands log only warnings (to stderr); the server logs info.
  const logger = createLogger(command === "serve" || command === "daemon" ? config.logLevel : "error", { service: "recordful-mcp" });

  switch (command) {
    case "serve":
      return serve(config, logger);
    case "daemon":
      return daemon(config, logger);
    case "setup":
      return void process.stdout.write(setupGuide());
    case "prompt":
      return void process.stdout.write(SETUP_PROMPT);
    case "guide":
      return void out(JSON.stringify(guide(version), null, 2));
    case "install":
      return installCommand(rest);
    case "unpair":
      return unpairCommand(config, rest);
    case "status": {
      const parsed = parseArgs(rest);
      return statusCommand(config, logger, parsed.flags.json === true);
    }
    default:
      return runCommand(command, parseArgs(rest), config, logger);
  }
};

main().catch((err: unknown) => {
  const e = err instanceof BridgeError ? err : null;
  const hint = (e?.data as { hint?: string } | undefined)?.hint;
  process.stderr.write(
    `recordful-mcp: ${e ? `${e.code}: ${e.message}` : err instanceof Error ? err.message : String(err)}${hint ? `\n${hint}` : ""}\n`,
  );
  process.exit(1);
});
