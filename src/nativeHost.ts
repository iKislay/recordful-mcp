// The relay that lets Recordful connect with no click. Chrome starts it
// (`recordful-mcp native-host`) when the extension calls connectNative; it
// watches the bridge port without Chrome logging anything, tells the
// extension when the bridge is up, and then carries WebSocket frames between
// them. It never reads them: the pairing proof is still end to end.
//
// The MCP server registers it each time it starts (registerNativeHost), so
// the launcher always points at the recordful-mcp that is running.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import WebSocket from "ws";

export const NATIVE_HOST_NAME = "app.recordful.bridge";
const PROBE_MS = 2_000;

// ---- registration ----------------------------------------------------------

export interface RegisterOptions {
  extensionIds: string[];
  cliPath: string;
  nodePath?: string;
  home?: string;
  os?: NodeJS.Platform;
  // Runs `reg` on Windows; replaced in tests.
  runReg?: (args: string[]) => { status: number | null; stdout: string };
}

// Browsers read their own registry key (Windows) or folder (macOS, Linux).
const WINDOWS_KEYS = [
  "Software\\Google\\Chrome",
  "Software\\Microsoft\\Edge",
  "Software\\BraveSoftware\\Brave-Browser",
  "Software\\Chromium",
];
const browserDirs = (home: string, os: NodeJS.Platform): string[] =>
  os === "darwin"
    ? ["Google/Chrome", "Microsoft Edge", "BraveSoftware/Brave-Browser", "Chromium"].map((d) =>
        join(home, "Library", "Application Support", d),
      )
    : ["google-chrome", "microsoft-edge", "BraveSoftware/Brave-Browser", "chromium"].map((d) => join(home, ".config", d));

const writeIfChanged = (path: string, text: string): boolean => {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return true;
};

// Returns where the manifest went. Only a built recordful-mcp registers: a
// launcher can't start the TypeScript sources.
export const registerNativeHost = (opts: RegisterOptions): string[] => {
  if (!opts.cliPath.endsWith(".js") || opts.extensionIds.length === 0) return [];
  const os = opts.os ?? platform();
  const home = opts.home ?? homedir();
  const node = opts.nodePath ?? process.execPath;
  const dir = join(home, ".recordful", "native-host");
  const windows = os === "win32";
  const launcher = join(dir, windows ? "recordful-native-host.cmd" : "recordful-native-host.sh");
  // Claude Desktop runs .mcpb servers on its own Electron; without this the
  // launcher would start the Claude app instead of the relay. Plain Node ignores it.
  const launcherText = windows
    ? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${node}" "${opts.cliPath}" native-host %*\r\n`
    : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${node}" "${opts.cliPath}" native-host "$@"\n`;
  writeIfChanged(launcher, launcherText);
  if (!windows) chmodSync(launcher, 0o755);
  const manifest = `${JSON.stringify(
    {
      name: NATIVE_HOST_NAME,
      description: "Recordful agent relay (recordful-mcp)",
      path: launcher,
      type: "stdio",
      allowed_origins: opts.extensionIds.map((id) => `chrome-extension://${id}/`),
    },
    null,
    2,
  )}\n`;

  if (windows) {
    const manifestPath = join(dir, `${NATIVE_HOST_NAME}.json`);
    writeIfChanged(manifestPath, manifest);
    const reg = opts.runReg ?? ((args) => {
      const r = spawnSync("reg", args, { encoding: "utf8", windowsHide: true });
      return { status: r.status, stdout: r.stdout ?? "" };
    });
    const done: string[] = [];
    for (const browser of WINDOWS_KEYS) {
      const key = `HKCU\\${browser}\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
      const current = reg(["query", key, "/ve"]);
      if (current.status !== 0 || !current.stdout.includes(manifestPath)) {
        if (reg(["add", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"]).status !== 0) continue;
      }
      done.push(key);
    }
    return done;
  }
  // Only browsers that are installed (their profile folder exists).
  return browserDirs(home, os)
    .filter((d) => existsSync(d))
    .map((d) => {
      const path = join(d, "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`);
      writeIfChanged(path, manifest);
      return path;
    });
};

// ---- the relay -------------------------------------------------------------

// Chrome's framing: a 4-byte little-endian length, then UTF-8 JSON.
export const encodeFrame = (msg: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
};

export const createFrameReader = (onMessage: (msg: unknown) => void) => {
  let buf = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) return;
      const body = buf.subarray(4, 4 + len).toString("utf8");
      buf = buf.subarray(4 + len);
      try {
        onMessage(JSON.parse(body));
      } catch {
        // A frame we can't read is dropped, not fatal.
      }
    }
  };
};

const reachable = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.setTimeout(1_000, () => done(false));
  });

type Incoming =
  | { t: "hello"; port: number; path: string }
  | { t: "open" }
  | { t: "msg"; data: string }
  | { t: "close"; code?: number; reason?: string };

// `origin` is the first argument Chrome passes: chrome-extension://<id>/.
export const runNativeHost = (origin: string | undefined) => {
  const send = (msg: unknown) => process.stdout.write(encodeFrame(msg));
  let port = 0;
  let path = "";
  let ws: WebSocket | null = null;
  let wasUp = false;
  let probe: NodeJS.Timeout | null = null;

  const check = async () => {
    // While a session is open the bridge is up by definition.
    const up = ws !== null || (await reachable(port));
    if (up && !wasUp && ws === null) send({ t: "up" });
    wasUp = up;
  };

  const open = () => {
    ws?.terminate();
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      // The bridge only takes Recordful's own origin, which Chrome vouched for.
      origin: origin?.replace(/\/$/, ""),
      handshakeTimeout: 5_000,
    });
    ws = socket;
    socket.on("open", () => send({ t: "open" }));
    socket.on("message", (data) => {
      if (ws === socket) send({ t: "msg", data: data.toString() });
    });
    socket.on("close", (code, reason) => {
      // A socket the extension already replaced must not close the new one.
      if (ws !== socket) return;
      ws = null;
      send({ t: "close", code, reason: reason.toString() });
    });
    socket.on("error", () => {});
  };

  const handle = (raw: unknown) => {
    const msg = raw as Incoming;
    if (msg?.t === "hello" && Number.isInteger(msg.port) && typeof msg.path === "string" && msg.path.startsWith("/")) {
      port = msg.port;
      path = msg.path;
      if (!probe) {
        void check();
        probe = setInterval(() => void check(), PROBE_MS);
      }
    } else if (msg?.t === "open" && port) {
      open();
    } else if (msg?.t === "msg" && typeof msg.data === "string") {
      if (ws?.readyState === WebSocket.OPEN) ws.send(msg.data);
    } else if (msg?.t === "close" && ws) {
      const code = Number(msg.code);
      if (ws.readyState === WebSocket.OPEN) ws.close(code === 1000 || (code >= 3000 && code < 5000) ? code : 1000, String(msg.reason ?? "").slice(0, 120));
      else ws.terminate();
    }
  };

  process.stdin.on("data", createFrameReader(handle));
  // Chrome closes our stdin when the extension disconnects or quits.
  process.stdin.on("end", () => process.exit(0));
};
