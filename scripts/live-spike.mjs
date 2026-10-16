// Live end-to-end check: the real bridge plus a real bridge-enabled Recordful
// build, driven by Playwright in a throwaway browser profile.
//
// usage:
//   node scripts/live-spike.mjs --extension <recordful/build> --out <dir>
//        [--channel msedge|chrome] [--shortcut]
//
// Needs `npm run build` here, `npm run build:agent` in the recordful repo, and
// Playwright from the recordful repo (already a devDependency there). Branded
// Chrome ignores --load-extension since v137, so use Playwright's Chromium or
// --channel msedge.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadOrCreateToken } from "../dist/auth/token.js";
import { BridgeServer } from "../dist/bridge/BridgeServer.js";
import { loadConfig } from "../dist/config.js";
import { createLogger } from "../dist/logger.js";

const { values: args } = parseArgs({
  options: {
    extension: { type: "string" },
    out: { type: "string", default: join(dirname(fileURLToPath(import.meta.url)), "..", "spike-out") },
    channel: { type: "string" },
    shortcut: { type: "boolean", default: false },
  },
});
if (!args.extension) {
  console.error("--extension <path to recordful/build> is required");
  process.exit(2);
}
const extDir = resolve(args.extension);
const outDir = resolve(args.out);
mkdirSync(outDir, { recursive: true });

const { chromium } = createRequire(join(extDir, "..", "package.json"))("@playwright/test");

const report = { startedAt: new Date().toISOString(), steps: [] };
const step = (name, data) => {
  report.steps.push({ name, at: new Date().toISOString(), data });
  console.log(`\n== ${name}\n${JSON.stringify(data, null, 2)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (bridge, method, params = {}, timeoutMs = 20000) => {
  try {
    return { ok: true, result: await bridge.request(method, params, timeoutMs) };
  } catch (e) {
    return { ok: false, error: { code: e.code, message: e.message, data: e.data } };
  }
};

const config = loadConfig();
const { token } = await loadOrCreateToken({ path: config.tokenPath, envToken: config.envToken });
const bridge = new BridgeServer({
  port: config.port,
  token,
  allowedExtensionIds: config.allowedExtensionIds,
  handshakeTimeoutMs: config.handshakeTimeoutMs,
  heartbeatTimeoutMs: config.heartbeatTimeoutMs,
  logger: createLogger("info"),
});
await bridge.start();

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "recordful-spike-")), {
  headless: false,
  channel: args.channel,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
  step("extension loaded", { swUrl: sw.url() });
  step("bridge session", await bridge.waitForSession(30000).catch((e) => ({ error: e.message })));

  // The install flow opens a setup tab that would steal focus.
  await sleep(2000);
  for (const p of ctx.pages()) if (p.url().startsWith("chrome-extension://")) await p.close();

  await sw.evaluate(() => chrome.storage.local.set({ recordingType: "tab" }));
  const page = await ctx.newPage();
  await page.goto("https://example.com", { waitUntil: "load" });
  await page.bringToFront();
  await sleep(1500);
  step("status.get", await call(bridge, "status.get"));

  let state;
  if (args.shortcut) {
    // Checks whether a CDP-dispatched key reaches extension commands (it doesn't
    // on Edge 155: commands need real OS input).
    await page.keyboard.press("Alt+Shift+G");
    await sleep(15000);
    const s = await call(bridge, "status.get");
    step("status after Alt+Shift+G", s);
    state = s.result?.state;
  } else {
    step("capture.probe (no user gesture)", await call(bridge, "capture.probe"));
    // An unconsumed tab-capture stream ID holds the tab briefly; let it lapse.
    await sleep(8000);
    const start = await call(bridge, "recording.start", { timeoutMs: 30000 }, 45000);
    step("recording.start (no user gesture)", start);
    state = start.result?.outcome;
  }
  await page.screenshot({ path: join(outDir, "after-start.png") });

  if (state === "recording") {
    await sleep(3000);
    step("recording.pause", await call(bridge, "recording.pause"));
    await sleep(1500);
    step("recording.resume", await call(bridge, "recording.resume"));
    await sleep(3000);
    step("recording.stop", await call(bridge, "recording.stop", { timeoutMs: 30000 }, 60000));
    await sleep(3000);
    step("pages after stop", ctx.pages().map((p) => p.url()));
  }
  step("final status", await call(bridge, "status.get"));
} finally {
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  await ctx.close();
  await bridge.stop();
}
