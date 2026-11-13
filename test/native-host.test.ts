import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { createFrameReader, encodeFrame, NATIVE_HOST_NAME, registerNativeHost } from "../src/nativeHost.js";

const ID = "hkcgjbkibidgbefehehenlmhjanjaopc";

describe("registerNativeHost", () => {
  it("skips the TypeScript sources", () => {
    expect(registerNativeHost({ extensionIds: [ID], cliPath: "/x/src/cli.ts", home: mkdtempSync(join(tmpdir(), "rf-nh-")) })).toEqual([]);
  });

  it("writes the launcher and manifest and points each browser's key at it on Windows", () => {
    const home = mkdtempSync(join(tmpdir(), "rf-nh-"));
    const calls: string[][] = [];
    const where = registerNativeHost({
      extensionIds: [ID],
      cliPath: "C:\\rf\\dist\\cli.js",
      nodePath: "C:\\node\\node.exe",
      home,
      os: "win32",
      runReg: (args) => (calls.push(args), { status: args[0] === "query" ? 1 : 0, stdout: "" }),
    });
    const dir = join(home, ".recordful", "native-host");
    const manifest = JSON.parse(readFileSync(join(dir, `${NATIVE_HOST_NAME}.json`), "utf8"));
    expect(manifest.allowed_origins).toEqual([`chrome-extension://${ID}/`]);
    expect(manifest.path).toBe(join(dir, "recordful-native-host.cmd"));
    expect(readFileSync(manifest.path, "utf8")).toContain('"C:\\node\\node.exe" "C:\\rf\\dist\\cli.js" native-host %*');
    expect(where).toHaveLength(4);
    expect(calls.filter((c) => c[0] === "add")).toHaveLength(4);

    // Already registered: nothing is rewritten.
    calls.length = 0;
    const manifestPath = join(dir, `${NATIVE_HOST_NAME}.json`);
    registerNativeHost({
      extensionIds: [ID], cliPath: "C:\\rf\\dist\\cli.js", nodePath: "C:\\node\\node.exe", home, os: "win32",
      runReg: (args) => (calls.push(args), { status: 0, stdout: `(Default) REG_SZ ${manifestPath}` }),
    });
    expect(calls.filter((c) => c[0] === "add")).toHaveLength(0);
  });

  it("writes a manifest only for installed browsers on Linux", () => {
    const home = mkdtempSync(join(tmpdir(), "rf-nh-"));
    mkdirSync(join(home, ".config", "google-chrome"), { recursive: true });
    const where = registerNativeHost({ extensionIds: [ID], cliPath: "/rf/dist/cli.js", nodePath: "/usr/bin/node", home, os: "linux" });
    expect(where).toEqual([join(home, ".config", "google-chrome", "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`)]);
  });
});

describe("framing", () => {
  it("reads frames split across chunks", () => {
    const got: unknown[] = [];
    const read = createFrameReader((m) => got.push(m));
    const both = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: "é" })]);
    read(both.subarray(0, 3));
    read(both.subarray(3, 12));
    read(both.subarray(12));
    expect(got).toEqual([{ a: 1 }, { b: "é" }]);
  });
});

describe("relay", () => {
  it("says the bridge is up, then carries frames both ways with Recordful's origin", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((r) => wss.once("listening", r));
    const port = (wss.address() as AddressInfo).port;
    let origin: string | undefined;
    wss.on("connection", (ws, req) => {
      origin = req.headers.origin;
      ws.send("challenge");
      ws.on("message", (d) => ws.send(`echo:${d}`));
    });

    const cli = resolve(__dirname, "../src/cli.ts");
    const host = spawn(process.execPath, ["--import", "tsx", cli, "native-host", `chrome-extension://${ID}/`], { windowsHide: true });
    const got: Array<{ t: string; data?: string }> = [];
    host.stdout.on("data", createFrameReader((m) => got.push(m as { t: string })));
    const until = async (pred: () => boolean) => {
      for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 100));
      expect(pred()).toBe(true);
    };

    host.stdin.write(encodeFrame({ t: "hello", port, path: "/recordful-agent-bridge/v2" }));
    await until(() => got.some((m) => m.t === "up"));
    host.stdin.write(encodeFrame({ t: "open" }));
    await until(() => got.some((m) => m.t === "msg" && m.data === "challenge"));
    expect(got.map((m) => m.t)).toEqual(["up", "open", "msg"]);
    host.stdin.write(encodeFrame({ t: "msg", data: "hello" }));
    await until(() => got.some((m) => m.data === "echo:hello"));
    host.stdin.write(encodeFrame({ t: "close", code: 4401, reason: "bye" }));
    await until(() => got.some((m) => m.t === "close"));
    expect(origin).toBe(`chrome-extension://${ID}`);

    host.stdin.end();
    await new Promise((r) => host.once("close", r));
    wss.close();
  }, 20_000);
});
