// All runtime configuration comes from the environment so MCP clients can set
// it in their server entry (`env: {...}`) without any CLI flag plumbing.
// The bind host is deliberately not configurable: the bridge must never be
// reachable from another machine.
import { defaultTokenPath } from "./auth/token.js";
import { parseLogLevel, type LogLevel } from "./logger.js";
import { DEFAULT_PORT } from "./protocol/messages.js";

export interface BridgeConfig {
  port: number;
  // Empty means "any chrome-extension:// origin". Set it in anything beyond
  // local development so only your build of Recordful can pair.
  allowedExtensionIds: string[];
  tokenPath: string;
  envToken: string | undefined;
  handshakeTimeoutMs: number;
  // The extension pings every 20s; three missed pings and we drop it.
  heartbeatTimeoutMs: number;
  // Default per-request budget; recording calls add their own wait on top.
  requestTimeoutMs: number;
  // How long a tool call waits for the extension to (re)connect before failing.
  // Covers the service worker waking up after Chrome idled it.
  connectWaitMs: number;
  rebindIntervalMs: number;
  logLevel: LogLevel;
}

const EXTENSION_ID = /^[a-p]{32}$/;

const int = (value: string | undefined, fallback: number, name: string): number => {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  }
  return n;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): BridgeConfig => {
  const port = int(env.RECORDFUL_BRIDGE_PORT, DEFAULT_PORT, "RECORDFUL_BRIDGE_PORT");
  if (port > 65535) throw new Error("RECORDFUL_BRIDGE_PORT must be <= 65535");

  const allowedExtensionIds = (env.RECORDFUL_BRIDGE_ALLOWED_EXTENSION_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  for (const id of allowedExtensionIds) {
    if (!EXTENSION_ID.test(id)) {
      throw new Error(`"${id}" in RECORDFUL_BRIDGE_ALLOWED_EXTENSION_IDS is not a Chrome extension ID`);
    }
  }

  return {
    port,
    allowedExtensionIds,
    tokenPath: env.RECORDFUL_BRIDGE_TOKEN_PATH || defaultTokenPath(),
    envToken: env.RECORDFUL_BRIDGE_TOKEN,
    handshakeTimeoutMs: 5_000,
    heartbeatTimeoutMs: 65_000,
    requestTimeoutMs: int(env.RECORDFUL_BRIDGE_REQUEST_TIMEOUT_MS, 15_000, "RECORDFUL_BRIDGE_REQUEST_TIMEOUT_MS"),
    connectWaitMs: int(env.RECORDFUL_BRIDGE_CONNECT_WAIT_MS, 8_000, "RECORDFUL_BRIDGE_CONNECT_WAIT_MS"),
    rebindIntervalMs: 5_000,
    logLevel: parseLogLevel(env.RECORDFUL_BRIDGE_LOG_LEVEL),
  };
};

export const isValidExtensionId = (id: string): boolean => EXTENSION_ID.test(id);
