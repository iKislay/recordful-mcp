// One Chrome, two extensions: ext-wrangler → wrangler dev relay (:8787),
// ext-plain → plain Node relay (:8790); plus a Node client on wrangler.
// Polls all three every minute for HOLD_MIN minutes and reports who drops.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const here = (p) => new URL(p, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const HOLD_MIN = Number(process.env.HOLD_MIN || 20);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const ctl = new WebSocket("ws://127.0.0.1:8787/extension?u=node-ctl3");
ctl.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === "challenge") ctl.send(JSON.stringify({ type: "hello", protocolVersion: 2, token: "spike", client: {} }));
  if (m.type === "request") ctl.send(JSON.stringify({ type: "response", id: m.id, ok: true, result: { node: true } }));
};
ctl.onclose = (e) => log("NODE CONTROL closed", e.code, e.reason);
setInterval(() => ctl.readyState === WebSocket.OPEN && ctl.send('{"type":"ping"}'), 20000);

const profile = mkdtempSync("C:/Users/Kislay/AppData/Local/Temp/rhs3-");
const chrome = spawn(CHROME, [`--user-data-dir=${profile}`, "--remote-debugging-port=9333", "--enable-unsafe-extension-debugging",
  "--no-first-run", "--no-default-browser-check", "--headless=new", "about:blank"], { stdio: "ignore" });
let version;
for (let i = 0; i < 30 && !version; i++) { await sleep(500); version = await fetch("http://127.0.0.1:9333/json/version").then((r) => r.json()).catch(() => null); }
const cdp = async (fn) => {
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  try { return await fn(send); } finally { ws.close(); }
};
const ids = await cdp(async (send) => ({
  wrangler: (await send("Extensions.loadUnpacked", { path: here("./ext-wrangler") })).result.id,
  plain: (await send("Extensions.loadUnpacked", { path: here("./ext-plain") })).result.id,
}));
log("chrome", version.Browser, JSON.stringify(ids), "— CDP disconnected");
const readExtLog = (id) => cdp(async (send) => {
  const { result: { targetId } } = await send("Target.createTarget", { url: `chrome-extension://${id}/log.html` });
  const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
  await sleep(1500);
  const r = await send("Runtime.evaluate", { expression: "chrome.storage.local.get(null).then(JSON.stringify)", awaitPromise: true, returnByValue: true }, sessionId);
  await send("Target.closeTarget", { targetId });
  return r.result?.result?.value;
});
const ask = (base, u) => fetch(`${base}/call?u=${u}&method=status.get&timeoutMs=5000`).then((r) => r.json()).then((j) => j.result ? "up " + (j.result.uptimeS ?? "") : j.error.code).catch((e) => String(e));
await sleep(5000);
const started = Date.now();
const firstDrop = {};
while (Date.now() - started < HOLD_MIN * 60_000) {
  const s = { chromeWrangler: await ask("http://127.0.0.1:8787", "chrome-wrangler"), chromePlain: await ask("http://127.0.0.1:8790", "chrome-plain"), nodeWrangler: await ask("http://127.0.0.1:8787", "node-ctl3") };
  for (const [k, v] of Object.entries(s)) if (!v.startsWith("up") && !firstDrop[k]) firstDrop[k] = Math.round((Date.now() - started) / 1000) + "s";
  log(JSON.stringify(s));
  if (Object.keys(firstDrop).length === 3) break;
  await sleep(60_000);
}
log("DONE after", Math.round((Date.now() - started) / 1000), "s; first drop:", JSON.stringify(firstDrop));
log("ext-wrangler log:", await readExtLog(ids.wrangler));
log("ext-plain log:", await readExtLog(ids.plain));
chrome.kill();
process.exit(0);
