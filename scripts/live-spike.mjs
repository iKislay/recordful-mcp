// Live end-to-end check: the real bridge plus a real bridge-enabled Recordful
// build, driven by Playwright in a throwaway browser profile.
//
// usage:
//   node scripts/live-spike.mjs --extension <recordful/build> --out <dir>
//        [--channel msedge|chrome] [--shortcut] [--pages] [--port <n>]
//
// --pages runs the Phase 1 page tools against a local test page while a tab
// recording runs. Two stand-ins replace what a person does once: the browser
// is launched with --allowlisted-extension-id, a Chromium testing switch in
// place of the click on the Recordful icon (tab capture otherwise refuses to
// start), and a copy of the build declares its optional permissions as
// required, in place of the one-time permission prompt. The tab is armed
// through storage the way that click would arm it.
//
// --port runs the bridge on another port and points the extension at it, for
// when an MCP client's bridge already holds the default one.
//
// Needs `npm run build` here; a recordful development build made with
// RECORDFUL_AGENT_BRIDGE_TOKEN=<secret> (`npm run build:agent`), and the same
// secret in RECORDFUL_BRIDGE_TOKEN here, so the run needs no pairing window
// (scripts/live-pairing.mjs tests that); and
// Playwright from the recordful repo (already a devDependency there). Branded
// Chrome ignores --load-extension since v137, so use Playwright's Chromium or
// --channel msedge.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PairingStore } from "../dist/auth/pairings.js";
import { BridgeServer } from "../dist/bridge/BridgeServer.js";
import { loadConfig } from "../dist/config.js";
import { createLogger } from "../dist/logger.js";

const { values: args } = parseArgs({
  options: {
    extension: { type: "string" },
    out: { type: "string", default: join(dirname(fileURLToPath(import.meta.url)), "..", "spike-out") },
    channel: { type: "string" },
    shortcut: { type: "boolean", default: false },
    pages: { type: "boolean", default: false },
    port: { type: "string" },
  },
});
if (!args.extension) {
  console.error("--extension <path to recordful/build> is required");
  process.exit(2);
}
let extDir = resolve(args.extension);
const outDir = resolve(args.out);
mkdirSync(outDir, { recursive: true });

const { chromium } = createRequire(join(extDir, "..", "package.json"))("@playwright/test");

if (args.pages) {
  const copy = mkdtempSync(join(tmpdir(), "recordful-ext-"));
  cpSync(extDir, copy, { recursive: true });
  const manifestPath = join(copy, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.permissions = [...new Set([...(manifest.permissions || []), ...(manifest.optional_permissions || [])])];
  delete manifest.optional_permissions;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  extDir = copy;
}

const report = { startedAt: new Date().toISOString(), steps: [] };
const step = (name, data) => {
  report.steps.push({ name, at: new Date().toISOString(), data });
  const shown = JSON.stringify(data, (k, v) => (k === "data" && typeof v === "string" && v.length > 200 ? `<${v.length} chars>` : v), 2);
  console.log(`\n== ${name}\n${shown}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (bridge, method, params = {}, timeoutMs = 20000) => {
  const started = Date.now();
  try {
    const result = await bridge.request(method, params, timeoutMs);
    return { ok: true, ms: Date.now() - started, result };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: { code: e.code, message: e.message, data: e.data } };
  }
};

const config = loadConfig();
const port = args.port ? Number(args.port) : config.port;
if (!config.envSecret) {
  console.error("Set RECORDFUL_BRIDGE_TOKEN to the secret baked into the extension build.");
  process.exit(2);
}
const pairings = await PairingStore.open({
  path: join(mkdtempSync(join(tmpdir(), "recordful-spike-state-")), "agent-bridge.json"),
  envSecret: config.envSecret,
});
const bridge = new BridgeServer({
  port,
  pairings,
  // A throwaway profile's unpacked build has its own ID.
  allowedExtensionIds: [],
  handshakeTimeoutMs: config.handshakeTimeoutMs,
  pairingTimeoutMs: config.pairingTimeoutMs,
  heartbeatTimeoutMs: config.heartbeatTimeoutMs,
  logger: createLogger("info"),
});
await bridge.start();

// ---- test site for --pages ---------------------------------------------------

const TEST_PAGE = `<!doctype html>
<html><head><title>Page tools test</title>
<style>
  body { font: 16px system-ui, sans-serif; margin: 40px; }
  .fancy input { opacity: 0; position: absolute; }
  .fancy span::before { content: "☐ "; } .fancy input:checked + span::before { content: "☑ "; }
</style></head>
<body>
  <h1>Page tools test</h1>
  <button id="hello" onclick="document.getElementById('out').textContent = 'Clicked at ' + event.clientX + ',' + event.clientY + (event.isTrusted ? ' trusted' : ' synthetic')">Say hello</button>
  <p id="out"></p>
  <label class="fancy"><input type="checkbox" id="remember"><span>Remember me</span></label>
  <form action="/done" method="get">
    <label>Search <input name="q" autocomplete="off"></label>
    <button>Submit</button>
  </form>
  <div style="height: 2200px"></div>
  <a href="/done?q=footer">Footer link</a>
</body></html>`;

const site = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  res.setHeader("content-type", "text/html; charset=utf-8");
  if (url.pathname === "/done") {
    const q = String(url.searchParams.get("q") || "").replace(/[<>&]/g, "");
    res.end(`<!doctype html><title>Done</title><h1>Submitted</h1><p>q=${q}</p><a href="/">Back</a>`);
    return;
  }
  res.end(TEST_PAGE);
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const siteUrl = `http://127.0.0.1:${site.address().port}/`;

// ---- browser ---------------------------------------------------------------

const profile = mkdtempSync(join(tmpdir(), "recordful-spike-"));
const launch = (extraArgs = []) =>
  chromium.launchPersistentContext(profile, {
    headless: false,
    channel: args.channel,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, ...extraArgs],
  });
const workerOf = async (ctx) => {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
  return sw;
};

let ctx = await launch();
let sw = await workerOf(ctx);
const extensionId = new URL(sw.url()).host;
if (args.pages) {
  // The unpacked extension's ID comes from its path, so it is the same on relaunch.
  await ctx.close();
  ctx = await launch([
    `--allowlisted-extension-id=${extensionId}`,
    // Camera and microphone prompts would otherwise wait for a person too.
    // Not --use-fake-device-for-media-stream: tab capture fails with it.
    "--use-fake-ui-for-media-stream",
  ]);
  sw = await workerOf(ctx);
}

const consoleLines = [];
const runPages = async () => {
  ctx.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning" || /Recordful/.test(msg.text())) {
      consoleLines.push(`${msg.type()}: ${msg.text().slice(0, 300)}`);
    }
  });
  // No mic or camera, and askMicrophone off (what "Don't show again" on the
  // "microphone is muted" dialog stores): those prompts would hold the start
  // waiting for a person.
  await sw.evaluate(() => chrome.storage.local.set({ recordingType: "tab", askMicrophone: false, micActive: false, cameraActive: false }));
  const page = await ctx.newPage();
  await page.goto("https://example.com", { waitUntil: "load" });
  const other = await ctx.newPage();
  await other.goto("https://example.org", { waitUntil: "load" });
  await page.bringToFront();
  await sleep(1000);

  step("page.snapshot before any tab is armed (expect NOT_ARMED)", await call(bridge, "page.snapshot"));

  // What a click on the Recordful icon on `page` records.
  const armed = await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: "https://example.com/*" });
    await chrome.storage.session.set({ agentBridgeArmedTab: { tabId: tab.id, windowId: tab.windowId, via: "spike", at: Date.now() } });
    return tab.id;
  });
  step("armed tab", { tabId: armed });
  step("status.get", await call(bridge, "status.get"));

  step("page.navigate", await call(bridge, "page.navigate", { url: siteUrl }, 30000));
  const snap = await call(bridge, "page.snapshot");
  step("page.snapshot", snap);
  const find = (s, role, name) => s.result?.elements?.find((e) => e.role === role && e.name.includes(name))?.ref;
  const refs = {
    hello: find(snap, "button", "Say hello"),
    remember: find(snap, "checkbox", "Remember me"),
    search: find(snap, "textbox", "Search"),
    footer: find(snap, "link", "Footer link"),
  };
  step("refs", refs);

  const start = await call(bridge, "recording.start", { timeoutMs: 30000 }, 45000);
  step("recording.start", start);
  // If the start reported anything but "recording", see whether it went live anyway.
  let live = start.result?.outcome === "recording";
  for (let i = 0; !live && i < 40; i++) {
    await sleep(500);
    live = (await call(bridge, "status.get")).result?.state === "recording";
  }
  step("recording live", { live });
  step("start flow trace", await sw.evaluate(() => chrome.storage.local.get(["startFlowTrace", "recordingType", "pendingRecording"])));
  step("page console (Recordful warnings and errors)", consoleLines.splice(0).filter((l) => !l.includes("[AgentBridge] request")));
  await sleep(1500);

  step("page.click Say hello", await call(bridge, "page.click", { ref: refs.hello }, 30000));
  step("page.waitFor 'Clicked at'", await call(bridge, "page.waitFor", { text: "Clicked at", timeoutMs: 5000 }, 20000));
  step("button result text", await page.locator("#out").textContent());
  step("page.click Remember me (hidden checkbox behind its label)", await call(bridge, "page.click", { ref: refs.remember }, 30000));
  step("checkbox checked", await page.locator("#remember").isChecked());
  step("page.type Search", await call(bridge, "page.type", { ref: refs.search, text: "hello world" }, 30000));
  step("search value", await page.locator("input[name=q]").inputValue());
  step("page.scroll down", await call(bridge, "page.scroll", { direction: "down" }, 20000));
  step("page.scroll to footer link", await call(bridge, "page.scroll", { ref: refs.footer }, 20000));
  const shot = await call(bridge, "page.screenshot");
  if (shot.ok) writeFileSync(join(outDir, "page-screenshot.jpg"), Buffer.from(shot.result.data, "base64"));
  step("page.screenshot", shot.ok ? { ...shot, result: { ...shot.result, data: `<${shot.result.data.length} base64 chars>` } } : shot);
  await page.screenshot({ path: join(outDir, "during-recording.png") });

  step("recording.pause", await call(bridge, "recording.pause"));
  step("page.snapshot while paused (viewport)", await call(bridge, "page.snapshot", { scope: "viewport" }));
  step("recording.resume", await call(bridge, "recording.resume"));

  // The page tools follow the recorded tab, never the one in front.
  await other.bringToFront();
  await sleep(500);
  const elsewhere = await call(bridge, "page.snapshot", { scope: "viewport" });
  step("page.snapshot with another tab in front (expect the recorded tab's URL)", {
    ok: elsewhere.ok,
    url: elsewhere.result?.url,
    error: elsewhere.error,
  });
  step("page.screenshot with another tab in front (expect TAB_NOT_ACTIVE)", await call(bridge, "page.screenshot"));
  await page.bringToFront();
  await sleep(500);

  step("page.press Enter in Search (submits the form)", await call(bridge, "page.press", { key: "Enter" }, 30000));
  step("page.waitFor 'Submitted'", await call(bridge, "page.waitFor", { text: "Submitted", timeoutMs: 10000 }, 25000));
  step("page.click with a ref from the previous page (expect STALE_REF)", await call(bridge, "page.click", { ref: refs.hello }, 20000));
  step("page.navigate back to the test page", await call(bridge, "page.navigate", { url: siteUrl }, 30000));
  const again = await call(bridge, "page.snapshot", { scope: "viewport" });
  step("page.snapshot after navigation", { ok: again.ok, count: again.result?.elements?.length });
  await sleep(1500);

  if (live) {
    step("recording.stop", await call(bridge, "recording.stop", { timeoutMs: 30000 }, 60000));
    await sleep(3000);
    step("pages after stop", ctx.pages().map((p) => p.url()));
  }
};

const runRecorder = async () => {
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
};

try {
  step("extension loaded", { swUrl: sw.url(), allowlisted: args.pages });
  let session = null;
  for (let attempt = 0; attempt < 3 && !session; attempt++) {
    if (args.port) {
      // Changing the port makes the extension (re)connect to it. Removing it
      // first guarantees a change event even if it was already set.
      await sw.evaluate(async (p) => {
        await chrome.storage.local.remove("agentBridgePort");
        await chrome.storage.local.set({ agentBridgePort: p });
      }, port);
    }
    session = await bridge.waitForSession(10000).catch(() => null);
  }
  step("bridge session", session ?? { error: "the extension never connected" });
  if (!session) throw new Error("the extension never connected");

  // The install flow opens a setup tab that would steal focus.
  await sleep(2000);
  for (const p of ctx.pages()) if (p.url().startsWith("chrome-extension://")) await p.close();

  if (args.pages) await runPages();
  else await runRecorder();
  step("final status", await call(bridge, "status.get"));
} finally {
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  await ctx.close();
  await bridge.stop();
  site.close();
}
