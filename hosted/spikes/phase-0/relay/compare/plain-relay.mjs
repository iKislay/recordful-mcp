// Plain Node `ws` relay with the same frames as the Durable Object, so Chrome's
// side can be tested without wrangler/workerd in the path.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws");
import { createServer } from "node:http";
const sockets = new Map();
const pending = new Map();
let lastClose = null;
const http = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const u = url.searchParams.get("u");
  if (url.pathname === "/call") {
    const ws = sockets.get(u);
    if (!ws) return res.end(JSON.stringify({ ok: false, error: { code: "NOT_CONNECTED" }, lastClose }));
    const id = crypto.randomUUID();
    const r = await new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, error: { code: "TIMEOUT" } }), 5000);
      pending.set(id, (m) => (clearTimeout(t), resolve(m)));
      ws.send(JSON.stringify({ type: "request", id, method: "status.get", params: {} }));
    });
    return res.end(JSON.stringify(r));
  }
  res.end(JSON.stringify({ sockets: [...sockets.keys()], lastClose }));
});
new WebSocketServer({ server: http }).on("connection", (ws, req) => {
  const u = new URL(req.url, "http://x").searchParams.get("u");
  sockets.set(u, ws);
  ws.send(JSON.stringify({ type: "challenge", protocolVersion: 2, relay: true, serverNonce: "x" }));
  ws.on("message", (raw) => {
    const s = String(raw);
    if (s === '{"type":"ping"}') return ws.send('{"type":"pong"}');
    const m = JSON.parse(s);
    if (m.type === "hello") ws.send(JSON.stringify({ type: "welcome", sessionId: "x" }));
    if (m.type === "response") pending.get(m.id)?.(m);
  });
  ws.on("close", (code, reason) => { if (sockets.get(u) === ws) sockets.delete(u); lastClose = { u, code, reason: String(reason), at: new Date().toISOString().slice(11, 19) }; });
});
http.listen(8790, "127.0.0.1");
