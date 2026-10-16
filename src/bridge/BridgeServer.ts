// Loopback WebSocket server the extension dials into. The extension is the
// client because an MV3 service worker can't listen on a socket, and native
// messaging would tie the bridge's lifetime to Chrome's instead of the agent's.
//
// One authenticated session at a time: a new authenticated connection (the
// extension reloaded, or its service worker restarted) supersedes the old one.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { computeProof, newNonce, verifyProof } from "../auth/handshake.js";
import { isValidExtensionId } from "../config.js";
import type { Logger } from "../logger.js";
import { BridgeError, ErrorCode } from "../protocol/errors.js";
import {
  BRIDGE_HOST,
  BRIDGE_PATH,
  ClientMessage,
  CloseCode,
  HelloMessage,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  type ClientInfo,
  type EventMessage,
} from "../protocol/messages.js";

export interface BridgeServerOptions {
  port: number;
  token: string;
  allowedExtensionIds: string[];
  handshakeTimeoutMs: number;
  heartbeatTimeoutMs: number;
  logger: Logger;
}

export interface SessionInfo {
  sessionId: string;
  client: ClientInfo;
  connectedAt: string;
}

interface Session extends SessionInfo {
  ws: WebSocket;
  lastSeenAt: number;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: BridgeError) => void;
  timer: NodeJS.Timeout;
}

type Events = {
  connected: [SessionInfo];
  disconnected: [{ sessionId: string; reason: string }];
  event: [EventMessage];
};

const HEARTBEAT_CHECK_MS = 5_000;

export const originToExtensionId = (origin: string | undefined): string | null => {
  const match = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin ?? "");
  return match?.[1] ?? null;
};

export class BridgeServer extends EventEmitter<Events> {
  private readonly opts: BridgeServerOptions;
  private readonly log: Logger;
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private session: Session | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(opts: BridgeServerOptions) {
    super();
    for (const id of opts.allowedExtensionIds) {
      if (!isValidExtensionId(id)) throw new Error(`invalid extension id: ${id}`);
    }
    this.opts = opts;
    this.log = opts.logger.child({ component: "bridge" });
  }

  get listening(): boolean {
    return this.http?.listening ?? false;
  }

  get address(): { host: string; port: number } | null {
    const addr = this.http?.address() as AddressInfo | null | undefined;
    return addr ? { host: addr.address, port: addr.port } : null;
  }

  get currentSession(): SessionInfo | null {
    if (!this.session) return null;
    const { sessionId, client, connectedAt } = this.session;
    return { sessionId, client, connectedAt };
  }

  async start(): Promise<void> {
    if (this.http) return;
    const http = createServer((_req, res) => {
      // Plain HTTP gets nothing useful: no version, no hints for a scanner.
      res.writeHead(426, { "content-type": "text/plain" }).end("Upgrade Required\n");
    });
    const wss = new WebSocketServer({
      server: http,
      path: BRIDGE_PATH,
      maxPayload: MAX_MESSAGE_BYTES,
      verifyClient: (info, cb) => this.verifyClient(info.req, cb),
    });
    wss.on("connection", (ws, req) => this.onConnection(ws, req));
    wss.on("error", (err) => this.log.error("websocket server error", { err }));

    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        http.off("listening", onListening);
        wss.close();
        reject(
          err.code === "EADDRINUSE"
            ? new BridgeError(
                ErrorCode.BridgeUnavailable,
                `Port ${this.opts.port} is already in use, most likely by another recordful-mcp instance (one MCP client per machine can own the bridge).`,
              )
            : err,
        );
      };
      const onListening = () => {
        http.off("error", onError);
        resolve();
      };
      http.once("error", onError);
      http.once("listening", onListening);
      http.listen(this.opts.port, BRIDGE_HOST);
    });

    this.http = http;
    this.wss = wss;
    this.heartbeatTimer = setInterval(() => this.checkHeartbeat(), HEARTBEAT_CHECK_MS);
    this.heartbeatTimer.unref();
    this.log.info("listening", { host: BRIDGE_HOST, port: this.address?.port, path: BRIDGE_PATH });
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.dropSession(CloseCode.GoingAway, "bridge shutting down");
    const wss = this.wss;
    const http = this.http;
    this.wss = null;
    this.http = null;
    for (const client of wss?.clients ?? []) client.terminate();
    await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()));
  }

  // Resolves as soon as an authenticated extension is attached.
  waitForSession(timeoutMs: number): Promise<SessionInfo> {
    const current = this.currentSession;
    if (current) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("connected", onConnected);
        reject(
          new BridgeError(
            ErrorCode.NotConnected,
            "The Recordful extension is not connected to the bridge.",
            {
              hint: "The extension connects on demand: ask the user to click the Recordful toolbar icon (or press its shortcut) on the tab they want recorded, then retry. That click also grants the tab-capture permission Chrome requires. If it still fails, the extension build may be missing the agent bridge or have a different pairing token.",
            },
          ),
        );
      }, timeoutMs);
      const onConnected = (info: SessionInfo) => {
        clearTimeout(timer);
        resolve(info);
      };
      this.once("connected", onConnected);
    });
  }

  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const session = this.session;
    if (!session || session.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new BridgeError(ErrorCode.NotConnected, "The Recordful extension is not connected."),
      );
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(ErrorCode.Timeout, `${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      session.ws.send(JSON.stringify({ type: "request", id, method, params }), (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BridgeError(ErrorCode.Disconnected, `failed to send ${method}: ${err.message}`));
      });
      this.log.debug("request sent", { id, method });
    });
  }

  // ---- connection lifecycle ------------------------------------------------

  private verifyClient(
    req: IncomingMessage,
    cb: (ok: boolean, code?: number, message?: string) => void,
  ): void {
    // Browsers always send Origin on WebSocket upgrades, so this shuts out web
    // pages (DNS rebinding included). Native processes can forge it; the
    // token handshake is what stops those.
    const extensionId = originToExtensionId(req.headers.origin);
    const allowed =
      extensionId !== null &&
      (this.opts.allowedExtensionIds.length === 0 ||
        this.opts.allowedExtensionIds.includes(extensionId));
    if (!allowed) {
      this.log.warn("rejected connection: origin not allowed", {
        origin: req.headers.origin ?? null,
      });
      cb(false, 403, "Forbidden");
      return;
    }
    cb(true);
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const originId = originToExtensionId(req.headers.origin);
    const serverNonce = newNonce();
    let authenticated: Session | null = null;
    const log = this.log.child({ originId });

    const handshakeTimer = setTimeout(() => {
      log.warn("handshake timed out");
      ws.close(CloseCode.HandshakeTimeout, "handshake timeout");
    }, this.opts.handshakeTimeoutMs);

    ws.on("message", (raw: RawData, isBinary: boolean) => {
      const parsed = parseJson(raw, isBinary);
      if (parsed === undefined) {
        ws.close(CloseCode.BadMessage, "expected a JSON text frame");
        return;
      }

      if (!authenticated) {
        const hello = HelloMessage.safeParse(parsed);
        if (!hello.success) {
          ws.close(CloseCode.BadMessage, "expected hello");
          return;
        }
        if (hello.data.protocolVersion !== PROTOCOL_VERSION) {
          log.warn("protocol version mismatch", { client: hello.data.protocolVersion });
          ws.close(CloseCode.ProtocolVersion, `bridge speaks protocol ${PROTOCOL_VERSION}`);
          return;
        }
        if (hello.data.client.extensionId !== originId) {
          ws.close(CloseCode.AuthFailed, "authentication failed");
          return;
        }
        const expected = computeProof(this.opts.token, "client", serverNonce, hello.data.clientNonce);
        if (!verifyProof(expected, hello.data.proof)) {
          // Same reason string as above: don't tell a prober which check failed.
          log.warn("rejected connection: bad proof (token mismatch?)");
          ws.close(CloseCode.AuthFailed, "authentication failed");
          return;
        }
        clearTimeout(handshakeTimer);
        authenticated = {
          sessionId: randomUUID(),
          client: hello.data.client,
          connectedAt: new Date().toISOString(),
          ws,
          lastSeenAt: Date.now(),
        };
        ws.send(
          JSON.stringify({
            type: "welcome",
            sessionId: authenticated.sessionId,
            proof: computeProof(this.opts.token, "server", serverNonce, hello.data.clientNonce),
          }),
        );
        this.adoptSession(authenticated);
        return;
      }

      authenticated.lastSeenAt = Date.now();
      const msg = ClientMessage.safeParse(parsed);
      if (!msg.success) {
        log.warn("ignoring malformed message", { issues: msg.error.issues.length });
        return;
      }
      this.onClientMessage(authenticated, msg.data);
    });

    ws.on("close", (code, reason) => {
      clearTimeout(handshakeTimer);
      if (authenticated && this.session === authenticated) {
        this.session = null;
        this.rejectAllPending(ErrorCode.Disconnected, "the extension disconnected");
        log.info("session closed", { code, reason: reason.toString() });
        this.emit("disconnected", {
          sessionId: authenticated.sessionId,
          reason: reason.toString() || String(code),
        });
      }
    });

    ws.on("error", (err) => log.warn("socket error", { err }));

    ws.send(
      JSON.stringify({ type: "challenge", protocolVersion: PROTOCOL_VERSION, serverNonce }),
    );
  }

  private adoptSession(next: Session): void {
    if (this.session) {
      this.log.info("superseding previous session", { previous: this.session.sessionId });
      this.dropSession(CloseCode.Superseded, "superseded by a newer connection");
    }
    this.session = next;
    this.log.info("extension connected", {
      sessionId: next.sessionId,
      extensionId: next.client.extensionId,
      extensionVersion: next.client.extensionVersion,
    });
    this.emit("connected", this.currentSession as SessionInfo);
  }

  private dropSession(code: number, reason: string): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    this.rejectAllPending(ErrorCode.Disconnected, reason);
    session.ws.close(code, reason);
    this.emit("disconnected", { sessionId: session.sessionId, reason });
  }

  private onClientMessage(session: Session, msg: ClientMessage): void {
    switch (msg.type) {
      case "ping":
        session.ws.send(JSON.stringify({ type: "pong", ts: msg.ts }));
        return;
      case "event":
        this.emit("event", msg);
        return;
      case "response": {
        const pending = this.pending.get(msg.id);
        if (!pending) {
          this.log.debug("response for unknown or expired request", { id: msg.id });
          return;
        }
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.ok) pending.resolve(msg.result);
        else pending.reject(new BridgeError(msg.error.code, msg.error.message, msg.error.data));
        return;
      }
    }
  }

  private checkHeartbeat(): void {
    const session = this.session;
    if (!session) return;
    if (Date.now() - session.lastSeenAt > this.opts.heartbeatTimeoutMs) {
      this.log.warn("heartbeat timeout, dropping session", { sessionId: session.sessionId });
      this.dropSession(CloseCode.HeartbeatTimeout, "heartbeat timeout");
    }
  }

  private rejectAllPending(code: string, message: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new BridgeError(code, `${pending.method}: ${message}`));
      this.pending.delete(id);
    }
  }
}

const parseJson = (raw: RawData, isBinary: boolean): unknown => {
  if (isBinary) return undefined;
  try {
    return JSON.parse(raw.toString());
  } catch {
    return undefined;
  }
};
