#!/usr/bin/env node
// recordful-mcp: MCP server (default) plus a few operator commands for pairing
// and debugging the bridge without an MCP client in the loop.
import { createRequire } from "node:module";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadOrCreateToken } from "./auth/token.js";
import { BridgeServer } from "./bridge/BridgeServer.js";
import { keepBound } from "./bridge/keepBound.js";
import { loadConfig, type BridgeConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { createMcpServer } from "./mcp/createMcpServer.js";
import { BridgeError } from "./protocol/errors.js";
import { isMethod, METHODS } from "./protocol/methods.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const HELP = `recordful-mcp ${version}

Usage:
  recordful-mcp [serve]              Run the MCP server on stdio (what MCP clients launch)
  recordful-mcp token [--rotate]     Print the pairing token, creating it if needed
  recordful-mcp call <method> [json] Call one extension method directly and print the result
                                     methods: ${METHODS.join(", ")}
  recordful-mcp --version | --help

Environment:
  RECORDFUL_BRIDGE_PORT                    WebSocket port on 127.0.0.1 (default 47823)
  RECORDFUL_BRIDGE_TOKEN                   Pairing token (overrides the token file)
  RECORDFUL_BRIDGE_TOKEN_PATH              Token file (default ~/.recordful/agent-bridge.json)
  RECORDFUL_BRIDGE_ALLOWED_EXTENSION_IDS   Comma-separated extension IDs allowed to pair
  RECORDFUL_BRIDGE_LOG_LEVEL               debug | info | warn | error (default info, on stderr)
`;

const createBridge = (config: BridgeConfig, token: string, logger: Logger) =>
  new BridgeServer({
    port: config.port,
    token,
    allowedExtensionIds: config.allowedExtensionIds,
    handshakeTimeoutMs: config.handshakeTimeoutMs,
    heartbeatTimeoutMs: config.heartbeatTimeoutMs,
    logger,
  });

const warnOpenAllowlist = (config: BridgeConfig, logger: Logger) => {
  if (config.allowedExtensionIds.length === 0) {
    logger.warn(
      "RECORDFUL_BRIDGE_ALLOWED_EXTENSION_IDS is empty: any extension holding the token may pair. Pin your extension ID outside local development.",
    );
  }
};

const serve = async (config: BridgeConfig, logger: Logger) => {
  const { token, source, path } = await loadOrCreateToken({
    path: config.tokenPath,
    envToken: config.envToken,
  });
  logger.info("token loaded", { source, path: source === "env" ? null : path });
  warnOpenAllowlist(config, logger);

  const bridge = createBridge(config, token, logger);
  const binding = keepBound(bridge, config.rebindIntervalMs, logger);
  const mcp = createMcpServer({ bridge, binding, config, logger, version });

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

const tokenCommand = async (config: BridgeConfig, args: string[]) => {
  const loaded = await loadOrCreateToken({
    path: config.tokenPath,
    envToken: config.envToken,
    rotate: args.includes("--rotate"),
  });
  process.stdout.write(
    [
      `token:  ${loaded.token}`,
      `source: ${loaded.source}${loaded.source === "env" ? "" : ` (${loaded.path})`}`,
      "",
      "Give the extension the same token, either at build time:",
      `  RECORDFUL_AGENT_BRIDGE_TOKEN=${loaded.token}`,
      "or at runtime, from the extension service worker's DevTools console:",
      `  chrome.storage.local.set({ agentBridgeToken: "${loaded.token}" })`,
      "",
    ].join("\n"),
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
  const { token } = await loadOrCreateToken({ path: config.tokenPath, envToken: config.envToken });
  warnOpenAllowlist(config, logger);
  const bridge = createBridge(config, token, logger);
  await bridge.start();
  try {
    logger.info("waiting for the extension to connect (up to 60s)");
    await bridge.waitForSession(60_000);
    const extra = typeof params.timeoutMs === "number" ? params.timeoutMs : 30_000;
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
    case "token":
      return tokenCommand(config, rest);
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
