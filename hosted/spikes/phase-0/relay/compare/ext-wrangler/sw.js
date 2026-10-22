// Same as spike 1, plus a persistent event log (chrome.storage.local) so a
// stopped worker still tells us whether its socket closed first (server or
// network side) or the worker was killed with the socket open (Chrome side).
const RELAY = "ws://127.0.0.1:8787/extension?u=chrome-wrangler";
const bootId = crypto.randomUUID().slice(0, 8);
const bootAt = Date.now();
let ws = null;
let pongs = 0;
const note = async (ev, extra = {}) => {
  const { events = [] } = await chrome.storage.local.get("events");
  events.push({ t: new Date().toISOString().slice(11, 19), bootId, ev, ...extra });
  await chrome.storage.local.set({ events });
};
note("boot");
ws = new WebSocket(RELAY);
ws.onopen = () => note("open");
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === "challenge") ws.send(JSON.stringify({ type: "hello", protocolVersion: 2, token: "spike", client: { extensionId: chrome.runtime.id, bootId } }));
  if (msg.type === "pong") pongs++;
  if (msg.type === "request") ws.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result: { bootId, uptimeS: Math.round((Date.now() - bootAt) / 1000), pongs } }));
};
ws.onclose = (e) => note("close", { code: e.code, reason: e.reason, wasClean: e.wasClean, pongs });
ws.onerror = () => note("error");
setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"ping"}');
  chrome.storage.local.set({ lastTick: new Date().toISOString().slice(11, 19), lastReadyState: ws.readyState });
}, 20000);
