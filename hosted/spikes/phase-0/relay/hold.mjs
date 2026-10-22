// Launches Chrome (new headless) with its own profile, loads ext/ over CDP,
// then DISCONNECTS CDP so nothing keeps the worker alive artificially. Every
// 2 minutes asks the worker (through the relay) for its bootId. After
// HOLD_MIN minutes, tells it to stop pinging and watches it die.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import WebSocket from "ws";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const EXT = new URL("./ext", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const HOLD_MIN = Number(process.env.HOLD_MIN || 60);
const RELAY = "http://127.0.0.1:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const profile = mkdtempSync("C:/Users/Kislay/AppData/Local/Temp/rhs-");
const chrome = spawn(CHROME, [
  `--user-data-dir=${profile}`, "--remote-debugging-port=9333", "--enable-unsafe-extension-debugging",
  "--no-first-run", "--no-default-browser-check", "--headless=new", "about:blank",
], { stdio: "ignore" });
let version;
for (let i = 0; i < 30 && !version; i++) {
  await sleep(500);
  version = await fetch("http://127.0.0.1:9333/json/version").then((r) => r.json()).catch(() => null);
}
log("chrome", version.Browser);
const cdp = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => cdp.once("open", r));
const load = await new Promise((resolve) => {
  cdp.on("message", (raw) => { const m = JSON.parse(raw); if (m.id === 1) resolve(m); });
  cdp.send(JSON.stringify({ id: 1, method: "Extensions.loadUnpacked", params: { path: EXT } }));
});
log("loadUnpacked", JSON.stringify(load.result || load.error));
cdp.close();
log("CDP disconnected; nothing is attached to the worker now");

const ask = async (method = "status.get") =>
  fetch(`${RELAY}/call?u=chrome-hold&method=${method}&timeoutMs=5000`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
const stats = () => fetch(`${RELAY}/stats?u=chrome-hold`).then((r) => r.json());

await sleep(5000);
const boots = new Set();
const started = Date.now();
while (Date.now() - started < HOLD_MIN * 60_000) {
  const r = await ask();
  if (r.result) boots.add(r.result.bootId);
  log("worker", JSON.stringify(r.result || r.error), "boots seen:", boots.size);
  await sleep(2 * 60_000);
}
log("HOLD DONE. distinct worker boots during hold:", boots.size);

log("control: telling the worker to stop pinging");
log(JSON.stringify((await ask("stopPinging")).result));
for (let i = 0; i < 12; i++) {
  await sleep(15_000);
  const s = await stats();
  log(`+${(i + 1) * 15}s sockets=${s.sockets.length} lastClose=${JSON.stringify(s.lastClose)}`);
  if (!s.sockets.length) break;
}
chrome.kill();
process.exit(0);
