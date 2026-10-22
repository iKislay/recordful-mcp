// Phase 0 spike: the UserRelay shape. One Durable Object per user holds that
// user's extension WebSocket with the Hibernation API; the heartbeat is
// answered by setWebSocketAutoResponse so it never wakes the object; MCP-side
// calls are an RPC into the object that sends a request frame and awaits the
// matching response. Spike only: the user comes from ?u=, not a verified JWT.
import { DurableObject } from "cloudflare:workers";

const PING = '{"type":"ping"}';
const PONG = '{"type":"pong"}';
const HEARTBEAT_TIMEOUT_MS = 65_000;

export class UserRelay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pending = new Map();
    // Every construction is a wake from hibernation (or a cold start).
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const wakes = ((await ctx.storage.get("wakes")) ?? 0) + 1;
      await ctx.storage.put("wakes", wakes);
      this.wakes = wakes;
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // A newer connection supersedes the old one (close 4409), like local.
    for (const old of this.ctx.getWebSockets()) old.close(4409, "superseded");
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ connectedAt: Date.now(), authed: false });
    server.send(JSON.stringify({ type: "challenge", protocolVersion: 2, relay: true, serverNonce: crypto.randomUUID() }));
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    const msg = JSON.parse(raw);
    const att = ws.deserializeAttachment();
    if (msg.type === "hello") {
      ws.serializeAttachment({ ...att, authed: true, client: msg.client });
      ws.send(JSON.stringify({ type: "welcome", sessionId: crypto.randomUUID() }));
      return;
    }
    if (msg.type === "response") {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.resolve(msg);
      }
      return;
    }
    // Anything else that reaches here is counted: a non-auto-responded ping
    // would show up as wakes and as "handledMessages".
    await this.ctx.storage.put("handled", ((await this.ctx.storage.get("handled")) ?? 0) + 1);
  }

  async webSocketClose(ws, code, reason) {
    await this.ctx.storage.put("lastClose", { code, reason, at: Date.now() });
  }

  async alarm() {
    for (const ws of this.ctx.getWebSockets()) {
      const last = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? ws.deserializeAttachment().connectedAt;
      if (Date.now() - last > HEARTBEAT_TIMEOUT_MS) ws.close(4410, "heartbeat timeout");
    }
    if (this.ctx.getWebSockets().length) await this.ctx.storage.setAlarm(Date.now() + 30_000);
  }

  // RPC from the Worker's /mcp handler.
  async request(method, params, timeoutMs = 30_000) {
    await this.ready;
    const ws = this.ctx.getWebSockets().find((s) => s.deserializeAttachment().authed);
    if (!ws) return { ok: false, error: { code: "NOT_CONNECTED" } };
    const id = crypto.randomUUID();
    const started = Date.now();
    const res = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: { code: "TIMEOUT" } });
      }, timeoutMs);
      this.pending.set(id, { resolve: (m) => (clearTimeout(timer), resolve(m)) });
      ws.send(JSON.stringify({ type: "request", id, method, params }));
    });
    return { ...res, ms: Date.now() - started };
  }

  async stats() {
    await this.ready;
    const sockets = this.ctx.getWebSockets().map((ws) => ({
      ...ws.deserializeAttachment(),
      lastAutoResponse: this.ctx.getWebSocketAutoResponseTimestamp(ws)?.toISOString() ?? null,
    }));
    return {
      wakes: this.wakes,
      handled: (await this.ctx.storage.get("handled")) ?? 0,
      lastClose: (await this.ctx.storage.get("lastClose")) ?? null,
      sockets,
    };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const user = url.searchParams.get("u");
    if (!user) return new Response("missing u", { status: 400 });
    const stub = env.USER_RELAY.get(env.USER_RELAY.idFromName(user));
    if (url.pathname === "/extension") {
      if (request.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      return stub.fetch(request);
    }
    if (url.pathname === "/call") {
      const method = url.searchParams.get("method") || "status.get";
      const timeoutMs = Number(url.searchParams.get("timeoutMs") || 30000);
      return Response.json(await stub.request(method, {}, timeoutMs));
    }
    if (url.pathname === "/stats") return Response.json(await stub.stats());
    return new Response("not found", { status: 404 });
  },
};
