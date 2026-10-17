// Live check of the first-run experience a Chrome Web Store user gets: no
// secret baked in, AI agents off until switched on in Recordful's AI agents
// page, then a pairing window whose code must match the bridge's, Allow, and
// silent reconnects afterwards. Also checks Deny and the fail-fast start.
//
// usage:
//   node scripts/live-pairing.mjs --extension <recordful/build> --out <dir> [--channel msedge]
//
// Needs `npm run build` here and a recordful development build made WITHOUT
// RECORDFUL_AGENT_BRIDGE_TOKEN (`npm run build:agent`). Runs in a throwaway
// browser profile with a throwaway pairing file.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PairingStore } from "../dist/auth/pairings.js";
import { BridgeServer } from "../dist/bridge/BridgeServer.js";
import { loadConfig } from "../dist/config.js";
import { createLogger } from "../dist/logger.js";

const { values: args } = parseArgs({
  options: {
    extension: { type: "string" },
    out: { type: "string", default: "spike-out/pairing" },
    channel: { type: "string" },
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

const report = { startedAt: new Date().toISOString(), checks: [] };
let failed = 0;
const check = (name, ok, data) => {
  if (!ok) failed++;
  report.checks.push({ name, ok, data });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${data === undefined ? "" : `  ${JSON.stringify(data)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));

const config = loadConfig();
const pairings = await PairingStore.open({
  path: join(mkdtempSync(join(tmpdir(), "recordful-pairing-state-")), "agent-bridge.json"),
});
const makeBridge = () => {
  const b = new BridgeServer({
    port: config.port,
    pairings,
    allowedExtensionIds: [],
    handshakeTimeoutMs: config.handshakeTimeoutMs,
    pairingTimeoutMs: 60_000,
    heartbeatTimeoutMs: config.heartbeatTimeoutMs,
    logger: createLogger("warn"),
  });
  b.setAppName("Live Pairing Test");
  return b;
};
let bridge = makeBridge();
await bridge.start();

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "recordful-pairing-")), {
  headless: false,
  channel: args.channel,
  viewport: { width: 1100, height: 760 },
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});

// A new window's "page" event fires while it is still about:blank, so poll.
const pairWindow = async (seen = new Set(ctx.pages())) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const page = ctx.pages().find((p) => !seen.has(p) && p.url().includes("agents.html?pair=1"));
    if (page) return page;
    await sleep(200);
  }
  throw new Error("pairing window did not open");
};

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
  if (process.env.LIVE_DEBUG) {
    sw.on("console", (m) => {
      if (m.text().includes("AgentBridge") || m.type() === "error") console.log(`  [sw ${m.type()}] ${m.text()}`);
    });
  }
  const extension = sw.url().split("/").slice(0, 3).join("/");
  const extensionId = extension.split("/")[2];
  await sleep(2_500);
  for (const p of ctx.pages()) if (p.url().startsWith("chrome-extension://")) await p.close();

  // 1. Off by default: not even a connection attempt.
  check("off by default: no connection, no pairing", !bridge.currentSession && !bridge.pairing);

  // 2. Turn it on from the AI agents page; the pairing window opens.
  const agents = await ctx.newPage();
  await agents.goto(`${extension}/agents.html`);
  await agents.screenshot({ path: join(outDir, "1-agents-off.png") });
  check("agents page shows the setup command", (await agents.textContent("#setup-command")) === "npx -y recordful-mcp");
  const windowOpened = pairWindow(new Set(ctx.pages()));
  await agents.click("#enabled");
  const pairPage = await windowOpened;
  await pairPage.waitForSelector("#pair-code:not(:empty)");
  const shownCode = (await pairPage.textContent("#pair-code"))?.trim();
  check("pairing window shows the bridge's code", shownCode === bridge.pairing?.code, { shownCode, bridge: bridge.pairing?.code });
  check("pairing window names the app", (await pairPage.textContent("#pair-title"))?.includes("Live Pairing Test"));
  await pairPage.screenshot({ path: join(outDir, "2-pair-window.png") });

  // 3. Allow: paired and connected.
  const connected = settle(bridge.waitForSession(15_000));
  await pairPage.click("#allow");
  const session = await connected;
  check("connected after Allow", session.ok, session.ok ? undefined : session.e?.code);
  check("bridge stored the pairing", (await pairings.list()).some((p) => p.extensionId === extensionId));
  const stored = await sw.evaluate(() => chrome.storage.local.get(["agentBridgePairings"]));
  check("extension stored the pairing", Object.keys(stored.agentBridgePairings || {}).includes(pairings.serverId));
  check("toolbar badge says AI", (await sw.evaluate(() => chrome.action.getBadgeText({}))) === "AI");
  await sleep(500);
  await agents.screenshot({ path: join(outDir, "3-agents-connected.png") });
  check("agents page shows connected", (await agents.textContent("#status-text"))?.includes("Live Pairing Test"));
  const status = await settle(bridge.request("status.get", {}, 10_000));
  check("status.get answers", status.ok, status.ok ? status.v.state : status.e?.code);

  // 4. The MCP server restarts: Recordful reconnects on its own, no prompt.
  let promptedAgain = false;
  const onPage = (p) => {
    if (p.url().includes("pair=1")) promptedAgain = true;
  };
  ctx.on("page", onPage);
  await bridge.stop();
  bridge = makeBridge();
  await bridge.start();
  const back = await settle(bridge.waitForSession(15_000));
  check("reconnects after a bridge restart without prompting", back.ok && !promptedAgain, back.ok ? undefined : back.e?.code);
  ctx.off("page", onPage);

  // 5. Tab-capture start on a tab nobody handed over fails fast.
  const site = await ctx.newPage();
  await site.goto("https://example.com");
  await sw.evaluate(() => chrome.storage.local.set({ recordingType: "region" }));
  const t0 = Date.now();
  const start = await settle(bridge.request("recording.start", { timeoutMs: 30_000 }, 45_000));
  check("unarmed start fails fast with NOT_ARMED", !start.ok && start.e?.code === "NOT_ARMED" && Date.now() - t0 < 5_000, {
    code: start.ok ? null : start.e?.code,
    ms: Date.now() - t0,
  });

  // 6. The bridge forgets the pairing; the next gesture asks again; Deny.
  await pairings.remove();
  await bridge.stop();
  bridge = makeBridge();
  await bridge.start();
  await agents.bringToFront();
  await agents.click("#enabled"); // off
  await sleep(500);
  const secondWindow = pairWindow(new Set(ctx.pages()));
  await agents.click("#enabled"); // on: a gesture, so it may pair
  const denyPage = await secondWindow.catch(() => null);
  check("asks again after the bridge forgot it", denyPage !== null);
  if (denyPage) {
    await denyPage.waitForSelector("#pair-code:not(:empty)");
    await denyPage.click("#deny");
    await sleep(1_000);
    const denied = await settle(bridge.waitForSession(1_000));
    check("Deny is reported to the agent as PAIRING_DENIED", !denied.ok && denied.e?.code === "PAIRING_DENIED", denied.ok ? undefined : denied.e?.code);
  }

  // 7. Off means off.
  await agents.click("#enabled");
  await sleep(500);
  check("switching off disconnects", !bridge.currentSession);
} finally {
  report.failed = failed;
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  await ctx.close();
  await bridge.stop();
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
