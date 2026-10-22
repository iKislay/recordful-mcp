// Fake extension against the local relay: handshake, heartbeat via the
// auto-responded ping, answer requests; checks wakes don't grow with pings,
// supersede, and heartbeat timeout.
import WebSocket from "ws";

const BASE = process.env.RELAY || "http://127.0.0.1:8787";
const WS = BASE.replace(/^http/, "ws");
const user = `spike-${Date.now()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (path) => (await fetch(`${BASE}${path}${path.includes("?") ? "&" : "?"}u=${user}`)).json();
const pings = Number(process.env.PINGS || 10);
const pingEvery = Number(process.env.PING_MS || 2000);

const connect = () =>
  new Promise((resolve) => {
    const ws = new WebSocket(`${WS}/extension?u=${user}`, { origin: "chrome-extension://hkcgjbkibidgbefehehenlmhjanjaopc" });
    const state = { ws, pongs: 0, closed: null };
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === "challenge") ws.send(JSON.stringify({ type: "hello", protocolVersion: 2, token: "spike", client: { extensionId: "spike" } }));
      else if (msg.type === "welcome") resolve(state);
      else if (msg.type === "pong") state.pongs++;
      else if (msg.type === "request")
        ws.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result: { method: msg.method, at: Date.now() } }));
    });
    ws.on("close", (code, reason) => (state.closed = { code, reason: String(reason) }));
  });

const a = await connect();
const s0 = await get("/stats");
console.log("after connect:", JSON.stringify({ wakes: s0.wakes, handled: s0.handled }));

for (let i = 0; i < pings; i++) {
  a.ws.send('{"type":"ping"}');
  await sleep(pingEvery);
}
const s1 = await get("/stats");
console.log(`after ${pings} pings every ${pingEvery}ms: pongs=${a.pongs}`, JSON.stringify({ wakes: s1.wakes, handled: s1.handled, lastAutoResponse: s1.sockets[0]?.lastAutoResponse }));

const call = await get("/call?method=status.get");
console.log("request round trip:", JSON.stringify(call));

// Long call: the extension answers late (simulates a 20 s start_recording).
a.ws.removeAllListeners("message");
a.ws.on("message", async (raw) => {
  const msg = JSON.parse(raw);
  if (msg.type === "pong") a.pongs++;
  if (msg.type === "request") {
    await sleep(Number(process.env.SLOW_MS || 20000));
    a.ws.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result: { slow: true } }));
  }
});
const t = Date.now();
const slow = await get("/call?method=recording.start&timeoutMs=60000");
console.log(`slow call after ${Date.now() - t}ms:`, JSON.stringify(slow));

const b = await connect();
await sleep(500);
console.log("supersede: first socket closed with", JSON.stringify(a.closed));

if (process.env.HEARTBEAT) {
  console.log("silent for 100 s to hit the heartbeat timeout...");
  await sleep(100_000);
  console.log("heartbeat: closed with", JSON.stringify(b.closed), JSON.stringify((await get("/stats")).lastClose));
}
const s2 = await get("/stats");
console.log("final:", JSON.stringify({ wakes: s2.wakes, handled: s2.handled, sockets: s2.sockets.length }));
process.exit(0);
