// Holds a relay WebSocket the way remoteConnection.js would: fixed ping every
// 20 s (auto-responded by the Durable Object), answers requests. bootId
// changes whenever Chrome restarts this worker, so the driver can tell
// whether the socket really kept it alive.
const RELAY = "ws://127.0.0.1:8787/extension?u=chrome-hold";
const bootId = crypto.randomUUID().slice(0, 8);
const bootAt = Date.now();
let ws = null;
let pingTimer = null;
let pinging = true;
let pongs = 0;

const connect = () => {
  ws = new WebSocket(RELAY);
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "challenge") ws.send(JSON.stringify({ type: "hello", protocolVersion: 2, token: "spike", client: { extensionId: chrome.runtime.id, bootId } }));
    if (msg.type === "pong") pongs++;
    if (msg.type === "request") {
      if (msg.method === "stopPinging") pinging = false;
      ws.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result: { bootId, bootAt, uptimeS: Math.round((Date.now() - bootAt) / 1000), pongs, pinging } }));
    }
  };
  ws.onclose = () => {
    ws = null;
    clearInterval(pingTimer);
  };
  pingTimer = setInterval(() => {
    if (pinging && ws?.readyState === WebSocket.OPEN) ws.send('{"type":"ping"}');
  }, 20000);
};
connect();
