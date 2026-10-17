#!/usr/bin/env node
// recordful-mcp: MCP server (default) plus a few operator commands for setup,
// pairing and debugging the bridge without an MCP client in the loop.
import { createRequire } from "node:module";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PairingStore } from "./auth/pairings.js";
import { BridgeServer } from "./bridge/BridgeServer.js";
import { keepBound } from "./bridge/keepBound.js";
import { appDisplayName } from "./clientNames.js";
import { loadConfig, type BridgeConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { createMcpServer } from "./mcp/createMcpServer.js";
import { BridgeError } from "./protocol/errors.js";
import { isMethod, METHODS } from "./protocol/methods.js";
import { isPageMethod, pageExtraWaitMs, parsePageParams } from "./protocol/page.js";
import { setupGuide } from "./setupGuide.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const HELP = `recordful-mcp ${version}: let any AI app record product demos with Recordful

Usage:
  recordful-mcp                       Run the MCP server on stdio (what AI apps launch)
  recordful-mcp setup                 Show how to add Recordful to Claude, Cursor, VS Code, opencode and others
  recordful-mcp status                Show this computer's pairing state
  recordful-mcp unpair [<id>|--all]   Forget a paired Recordful extension (or all of them)
  recordful-mcp call <method> [json]  Call one extension method directly (debugging)
                                      methods: ${METHODS.join(", ")}
  recordful-mcp --version | --help

Environment (all optional):
  RECORDFUL_BRIDGE_PORT                    Local WebSocket port on 127.0.0.1 (default 47823)
  RECORDFUL_BRIDGE_ALLOWED_EXTENSION_IDS   Extra extension IDs allowed to connect, comma-separated
                                           (the Chrome Web Store build is always allowed; * allows any)
  RECORDFUL_BRIDGE_STATE_PATH              Pairing file (default ~/.recordful/agent-bridge.json)
  RECORDFUL_BRIDGE_TOKEN                   Shared secret instead of pairing, for CI and scripted runs
  RECORDFUL_BRIDGE_LOG_LEVEL               debug | info | warn | error (default info, on stderr)
`;

const openStore = (config: BridgeConfig) =>
  PairingStore.open({ path: config.statePath, envSecret: config.envSecret });

const createBridge = (config: BridgeConfig, pairings: PairingStore, logger: Logger) =>
  new BridgeServer({
    port: config.port,
    pairings,
    allowedExtensionIds: config.allowedExtensionIds,
    handshakeTimeoutMs: config.handshakeTimeoutMs,
    pairingTimeoutMs: config.pairingTimeoutMs,
    heartbeatTimeoutMs: config.heartbeatTimeoutMs,
    logger,
  });

const warnOpenAllowlist = (config: BridgeConfig, logger: Logger) => {
  if (config.allowedExtensionIds.length === 0) {
    logger.warn(
      "RECORDFUL_BRIDGE_ALLOWED_EXTENSION_IDS=* lets any extension connect and ask to pair. Use it for development only.",
    );
  }
};

const serve = async (config: BridgeConfig, logger: Logger) => {
  const pairings = await openStore(config);
  logger.info("pairing state loaded", { path: pairings.path, serverId: pairings.serverId });
  warnOpenAllowlist(config, logger);

  const bridge = createBridge(config, pairings, logger);
  const binding = keepBound(bridge, config.rebindIntervalMs, logger);
  const mcp = createMcpServer({ bridge, binding, config, logger, version });

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
    binding.stop();
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

const statusCommand = async (config: BridgeConfig) => {
  const pairings = await openStore(config);
  const list = await pairings.list();
  const lines = [
    `recordful-mcp ${version}`,
    `pairing file:  ${pairings.path}`,
    `bridge port:   127.0.0.1:${config.port}`,
    `allowed:       ${config.allowedExtensionIds.length ? config.allowedExtensionIds.join(", ") : "any extension (*)"}`,
    "",
    list.length
      ? "paired Recordful extensions:"
      : "No Recordful extension has paired with this computer yet. It happens the first time an AI app uses Recordful.",
    ...list.map((p) => `  ${p.extensionId}  first paired by ${p.app}, ${p.pairedAt}`),
    "",
  ];
  process.stdout.write(lines.join("\n"));
};

const unpairCommand = async (config: BridgeConfig, args: string[]) => {
  const [target] = args;
  if (!target) throw new Error("unpair needs an extension ID (see `recordful-mcp status`) or --all");
  const pairings = await openStore(config);
  const removed = await pairings.remove(target === "--all" ? undefined : target);
  process.stdout.write(
    removed
      ? `Forgot ${removed} pairing${removed === 1 ? "" : "s"}. Recordful will ask to pair again next time.\n`
      : "Nothing to forget.\n",
  );
};

const callCommand = async (config: BridgeConfig, logger: Logger, args: string[]) => {
  const [method, rawParams] = args;
  if (!method || !isMethod(method)) {
    throw new Error(`call needs a method: ${METHODS.join(", ")}`);
  }
  let params: Record<string, unknown> = {};
  if (rawParams) {
    const parsed: unknown = JSON.parse(rawParams);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("params must be a JSON object");
    }
    params = parsed as Record<string, unknown>;
  }
  if (isPageMethod(method)) params = parsePageParams(method, params) as Record<string, unknown>;
  const pairings = await openStore(config);
  warnOpenAllowlist(config, logger);
  const bridge = createBridge(config, pairings, logger);
  bridge.setAppName("recordful-mcp (command line)");
  await bridge.start();
  try {
    logger.info("waiting for Recordful to connect: click its toolbar icon in Chrome (up to 2 minutes)");
    const deadline = Date.now() + 120_000;
    for (;;) {
      try {
        await bridge.waitForSession(Math.max(1_000, deadline - Date.now()));
        break;
      } catch (err) {
        if (err instanceof BridgeError && err.code === "PAIRING_PENDING" && Date.now() < deadline) {
          logger.info("approve the pairing in Recordful", { code: (err.data as { code: string }).code });
          continue;
        }
        throw err;
      }
    }
    const extra = isPageMethod(method)
      ? pageExtraWaitMs(method, params)
      : typeof params.timeoutMs === "number"
        ? params.timeoutMs
        : 30_000;
    const result = await bridge.request(method, params, config.requestTimeoutMs + extra);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await bridge.stop();
  }
};

const main = async () => {
  const [command = "serve", ...rest] = process.argv.slice(2);
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${version}\n`);
    return;
  }

  const config = loadConfig();
  const logger = createLogger(config.logLevel, { service: "recordful-mcp" });

  switch (command) {
    case "serve":
      return serve(config, logger);
    case "setup":
      process.stdout.write(setupGuide());
      return;
    case "status":
      return statusCommand(config);
    case "unpair":
      return unpairCommand(config, rest);
    case "call":
      return callCommand(config, logger, rest);
    default:
      throw new Error(`unknown command "${command}"\n\n${HELP}`);
  }
};

main().catch((err: unknown) => {
  const out =
    err instanceof BridgeError
      ? `${err.code}: ${err.message}${err.data ? `\n${JSON.stringify(err.data, null, 2)}` : ""}`
      : err instanceof Error
        ? err.message
        : String(err);
  process.stderr.write(`recordful-mcp: ${out}\n`);
  process.exit(1);
});
