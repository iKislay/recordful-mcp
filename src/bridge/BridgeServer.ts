// Loopback WebSocket server the extension dials into. The extension is the
// client because an MV3 service worker can't listen on a socket, and native
// messaging would tie the bridge's lifetime to Chrome's instead of the agent's.
//
// One authenticated session at a time: a new authenticated connection (the
// extension reloaded, or its service worker restarted) supersedes the old one.
//
// An extension this machine hasn't paired with asks to pair first: the bridge
// sends a 4-digit code, the extension shows it next to Allow, the agent shows
// the same code in chat (PAIRING_PENDING), and on Allow the extension hands
// over a fresh secret that both sides keep for every later connection.
import { randomInt, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { computeProof, newNonce, verifyProof } from "../auth/handshake.js";
import type { PairingStore } from "../auth/pairings.js";
import { isValidExtensionId } from "../config.js";
import type { Logger } from "../logger.js";
import { BridgeError, ErrorCode } from "../protocol/errors.js";
import {
  BRIDGE_HOST,
  BRIDGE_PATH,
  ClientMessage,
  CloseCode,
  HandshakeMessage,
  MAX_MESSAGE_BYTES,
  MAX_PEERS,
  PEER_PATH,
  PeerMessage,
  type PeerCallMessage,
  PROTOCOL_VERSION,
  type ClientInfo,
  type EventMessage,
} from "../protocol/messages.js";

export type PairingStoreLike = Pick<PairingStore, "serverId" | "secretsFor" | "save">;

export interface BridgeServerOptions {
  port: number;
  pairings: PairingStoreLike;
  // Empty means any chrome-extension:// origin (development only).
  allowedExtensionIds: string[];
  handshakeTimeoutMs: number;
  // How long the user has to click Allow or Deny in Recordful.
  pairingTimeoutMs: number;
  heartbeatTimeoutMs: number;
  logger: Logger;
  // The secret other recordful-mcp processes prove to share this bridge.
  // Without it, peers are refused.
  peerSecret?: () => Promise<string>;
}

// What any recordful-mcp process (the owner here, or a peer forwarding to
// it) offers the MCP tools and the CLI.
export interface Bridge {
  waitForSession(timeoutMs: number): Promise<SessionInfo>;
  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
  state(): Promise<{ session: SessionInfo | null; pairing: PairingInfo | null }>;
  setAppName(name: string): void;
  readonly connection: { mode: "owner" | "peer" | "none"; error: string | null };
}

export interface PairingInfo {
  code: string;
  extensionId: string;
  app: string;
  startedAt: string;
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
  pairing: [PairingInfo];
  "pairing-ended": [{ outcome: "accepted" | "denied" | "abandoned" }];
};

// A denial stays visible to the agent this long, so its next call can say so
// instead of asking the user to approve again straight away.
const DENIAL_MEMORY_MS = 2 * 60_000;

const pairingPendingError = (pairing: PairingInfo) =>
  new BridgeError(
    ErrorCode.PairingPending,
    `Recordful is asking the user to approve ${pairing.app}. The code is ${pairing.code}.`,
    {
      code: pairing.code,
      hint: `Tell the user: "Recordful opened a window asking to connect ${pairing.app}. Check that it shows the code ${pairing.code}, then click Allow." Then retry. This is needed only once per computer.`,
    },
  );

const notConnectedError = () =>
  new BridgeError(ErrorCode.NotConnected, "The Recordful extension is not connected.", {
    hint: "Ask the user to click the Recordful toolbar icon in Chrome on the tab they want recorded, then retry. The first time only, they also turn on AI agents in Recordful (Recordful popup → More → AI agents, or paste chrome-extension://hkcgjbkibidgbefehehenlmhjanjaopc/agents.html into Chrome's address bar). If Recordful isn't installed: https://recordful.app",
  });

const HEARTBEAT_CHECK_MS = 5_000;

export const originToExtensionId = (origin: string | undefined): string | null => {
  const match = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin ?? "");
  return match?.[1] ?? null;
};

export class BridgeServer extends EventEmitter<Events> implements Bridge {
  private readonly opts: BridgeServerOptions;
  private readonly log: Logger;
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private session: Session | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pairingInProgress: (PairingInfo & { ws: WebSocket }) | null = null;
  private lastDeniedAt = 0;
  private app = "an AI app";
  private readonly peers = new Set<WebSocket>();
  // The last time a peer asked for anything, so an idle helper can exit.
  lastPeerActivityAt = Date.now();

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

  // The MCP client's name ("Claude Code"), shown in Recordful's pairing window.
  setAppName(name: string): void {
    const clean = name.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 80);
    if (clean) this.app = clean;
  }

  get connection(): { mode: "owner" | "peer" | "none"; error: string | null } {
    return { mode: this.listening ? "owner" : "none", error: null };
  }

  get peerCount(): number {
    return this.peers.size;
  }

  async state(): Promise<{ session: SessionInfo | null; pairing: PairingInfo | null }> {
    return { session: this.currentSession, pairing: this.pairing };
  }

  get pairing(): PairingInfo | null {
    if (!this.pairingInProgress) return null;
    const { ws: _ws, ...info } = this.pairingInProgress;
    return info;
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
    // Two endpoints on one port: the extension, and other recordful-mcp
    // processes. Routed by hand: ws can't share a server between paths.
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
    const peerWss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
    wss.on("error", (err) => this.log.error("websocket server error", { err }));
    peerWss.on("error", (err) => this.log.error("peer websocket server error", { err }));
    http.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
      const path = (req.url ?? "").split("?")[0];
      const refuse = (status: number, text: string) => {
        socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      };
      if (path === BRIDGE_PATH) {
        this.verifyClient(req, (ok, code, message) => {
          if (!ok) return refuse(code ?? 403, message ?? "Forbidden");
          wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
        });
        return;
      }
      if (path === PEER_PATH && this.opts.peerSecret) {
        // Browsers always send Origin; a peer is a local process, never a page.
        if (req.headers.origin !== undefined) return refuse(403, "Forbidden");
        if (this.peers.size >= MAX_PEERS) return refuse(503, "Service Unavailable");
        peerWss.handleUpgrade(req, socket, head, (ws) => this.onPeer(ws));
        return;
      }
      refuse(404, "Not Found");
    });

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
    this.abandonPairing("bridge shutting down");
    for (const peer of this.peers) peer.close(CloseCode.GoingAway, "bridge shutting down");
    this.peers.clear();
    const wss = this.wss;
    const http = this.http;
    this.wss = null;
    this.http = null;
    for (const client of wss?.clients ?? []) client.terminate();
    await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()));
  }

  // Resolves as soon as an authenticated extension is attached. While the
  // user is being asked to pair it waits for their answer, and a pairing that
  // starts mid-wait ends the wait at once so the agent can show the code.
  waitForSession(timeoutMs: number): Promise<SessionInfo> {
    const current = this.currentSession;
    if (current) return Promise.resolve(current);
    if (!this.pairingInProgress && Date.now() - this.lastDeniedAt < DENIAL_MEMORY_MS) {
      return Promise.reject(
        new BridgeError(ErrorCode.PairingDenied, "The user declined to connect Recordful to this app.", {
          hint: "Don't retry on your own. If the user wants to connect after all, they can click the Recordful icon again and choose Allow.",
        }),
      );
    }
    const waitingOnPairing = this.pairingInProgress !== null;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off("connected", onConnected);
        this.off("pairing", onPairing);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(this.pairingInProgress ? pairingPendingError(this.pairing as PairingInfo) : notConnectedError());
      }, timeoutMs);
      const onConnected = (info: SessionInfo) => {
        cleanup();
        resolve(info);
      };
      const onPairing = (info: PairingInfo) => {
        if (waitingOnPairing) return;
        cleanup();
        reject(pairingPendingError(info));
      };
      this.on("connected", onConnected);
      this.on("pairing", onPairing);
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
    // pages (DNS rebinding included) and other extensions. Native processes
    // can forge it; pairing secrets are what stop those.
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
    const originId = originToExtensionId(req.headers.origin) as string;
    const serverNonce = newNonce();
    let authenticated: Session | null = null;
    let pairing = false;
    const log = this.log.child({ originId });

    let handshakeTimer = setTimeout(() => {
      log.warn("handshake timed out");
      ws.close(CloseCode.HandshakeTimeout, "handshake timeout");
    }, this.opts.handshakeTimeoutMs);

    const fail = (code: number, reason: string) => {
      clearTimeout(handshakeTimer);
      ws.close(code, reason);
    };

    // Handshake steps await the pairing store, so messages are handled in
    // order: a hello must never overtake the pair_accept that makes it valid.
    let inbox = Promise.resolve();

    const onHandshake = async (msg: HandshakeMessage) => {
      if ((msg.type === "hello" || msg.type === "pair_request") && msg.protocolVersion !== PROTOCOL_VERSION) {
        log.warn("protocol version mismatch", { client: msg.protocolVersion });
        fail(CloseCode.ProtocolVersion, `bridge speaks protocol ${PROTOCOL_VERSION}`);
        return;
      }

      switch (msg.type) {
        case "pair_request": {
          if (pairing || msg.client.extensionId !== originId) {
            fail(CloseCode.BadMessage, "unexpected pair_request");
            return;
          }
          // One prompt at a time: a newer request (the user clicked again)
          // replaces the older one.
          this.abandonPairing("superseded by a newer pairing request");
          pairing = true;
          clearTimeout(handshakeTimer);
          handshakeTimer = setTimeout(() => {
            log.info("pairing timed out waiting for the user");
            this.endPairing(ws, "abandoned");
            ws.close(CloseCode.PairingTimeout, "pairing timed out");
          }, this.opts.pairingTimeoutMs);
          const info: PairingInfo = {
            code: String(randomInt(0, 10_000)).padStart(4, "0"),
            extensionId: originId,
            app: this.app,
            startedAt: new Date().toISOString(),
          };
          this.pairingInProgress = { ...info, ws };
          ws.send(JSON.stringify({ type: "pair_code", code: info.code }));
          log.info("pairing requested", { app: info.app });
          this.emit("pairing", info);
          return;
        }
        case "pair_accept": {
          if (!pairing || this.pairingInProgress?.ws !== ws) {
            fail(CloseCode.BadMessage, "unexpected pair_accept");
            return;
          }
          await this.opts.pairings.save(originId, msg.secret, this.app);
          pairing = false;
          clearTimeout(handshakeTimer);
          handshakeTimer = setTimeout(
            () => fail(CloseCode.HandshakeTimeout, "handshake timeout"),
            this.opts.handshakeTimeoutMs,
          );
          log.info("paired", { app: this.app });
          this.endPairing(ws, "accepted");
          return;
        }
        case "pair_reject": {
          if (!pairing) {
            fail(CloseCode.BadMessage, "unexpected pair_reject");
            return;
          }
          log.info("pairing declined by the user");
          this.lastDeniedAt = Date.now();
          this.endPairing(ws, "denied");
          fail(CloseCode.PairingRejected, "pairing declined");
          return;
        }
        case "hello": {
          if (pairing || msg.client.extensionId !== originId) {
            fail(CloseCode.AuthFailed, "authentication failed");
            return;
          }
          const secrets = await this.opts.pairings.secretsFor(originId);
          const secret = secrets.find((candidate) =>
            verifyProof(computeProof(candidate, "client", serverNonce, msg.clientNonce), msg.proof),
          );
          if (!secret) {
            // Same reason for every failure: don't tell a prober which check failed.
            log.warn("rejected connection: bad proof (not paired with this machine?)");
            fail(CloseCode.AuthFailed, "authentication failed");
            return;
          }
          clearTimeout(handshakeTimer);
          this.lastDeniedAt = 0;
          authenticated = {
            sessionId: randomUUID(),
            client: msg.client,
            connectedAt: new Date().toISOString(),
            ws,
            lastSeenAt: Date.now(),
          };
          ws.send(
            JSON.stringify({
              type: "welcome",
              sessionId: authenticated.sessionId,
              proof: computeProof(secret, "server", serverNonce, msg.clientNonce),
            }),
          );
          this.adoptSession(authenticated);
          return;
        }
      }
    };

    ws.on("message", (raw: RawData, isBinary: boolean) => {
      const parsed = parseJson(raw, isBinary);
      if (parsed === undefined) {
        fail(CloseCode.BadMessage, "expected a JSON text frame");
        return;
      }

      if (!authenticated) {
        const msg = HandshakeMessage.safeParse(parsed);
        if (!msg.success) {
          fail(CloseCode.BadMessage, "expected a handshake message");
          return;
        }
        inbox = inbox
          .then(() => onHandshake(msg.data))
          .catch((err: unknown) => {
            log.error("handshake failed", { err });
            fail(CloseCode.AuthFailed, "authentication failed");
          });
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
      if (pairing) this.endPairing(ws, "abandoned");
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
      JSON.stringify({
        type: "challenge",
        protocolVersion: PROTOCOL_VERSION,
        serverNonce,
        serverId: this.opts.pairings.serverId,
        app: this.app,
      }),
    );
  }

  // ---- peers -----------------------------------------------------------------

  private onPeer(ws: WebSocket): void {
    const serverNonce = newNonce();
    let authed = false;
    let app: string | undefined;
    let lastSeenAt = Date.now();
    const log = this.log.child({ peer: true });
    const fail = (code: number, reason: string) => ws.close(code, reason);
    const handshakeTimer = setTimeout(() => fail(CloseCode.HandshakeTimeout, "handshake timeout"), this.opts.handshakeTimeoutMs);
    const idleTimer = setInterval(() => {
      if (Date.now() - lastSeenAt > this.opts.heartbeatTimeoutMs) fail(CloseCode.HeartbeatTimeout, "heartbeat timeout");
    }, HEARTBEAT_CHECK_MS);
    idleTimer.unref();
    this.peers.add(ws);

    let inbox = Promise.resolve();
    ws.on("message", (raw: RawData, isBinary: boolean) => {
      const parsed = parseJson(raw, isBinary);
      const msg = parsed === undefined ? null : PeerMessage.safeParse(parsed);
      if (!msg?.success) {
        fail(CloseCode.BadMessage, "bad peer message");
        return;
      }
      lastSeenAt = Date.now();
      const data = msg.data;
      inbox = inbox
        .then(async () => {
          if (!authed) {
            if (data.type !== "peer_hello") return fail(CloseCode.BadMessage, "expected peer_hello");
            if (data.protocolVersion !== PROTOCOL_VERSION) {
              return fail(CloseCode.ProtocolVersion, `bridge speaks protocol ${PROTOCOL_VERSION}`);
            }
            const secret = await this.opts.peerSecret!();
            if (!verifyProof(computeProof(secret, "peer", serverNonce, data.clientNonce), data.proof)) {
              log.warn("rejected peer: bad proof");
              return fail(CloseCode.AuthFailed, "authentication failed");
            }
            clearTimeout(handshakeTimer);
            authed = true;
            app = data.app;
            ws.send(
              JSON.stringify({
                type: "peer_welcome",
                proof: computeProof(secret, "peer-server", serverNonce, data.clientNonce),
              }),
            );
            log.debug("peer connected", { app });
            return;
          }
          if (data.type === "ping") {
            ws.send(JSON.stringify({ type: "pong", ts: data.ts }));
            return;
          }
          if (data.type === "peer_call") {
            this.lastPeerActivityAt = Date.now();
            void this.answerPeer(ws, data, app);
          }
        })
        .catch((err: unknown) => log.warn("peer message failed", { err }));
    });
    ws.on("close", () => {
      clearTimeout(handshakeTimer);
      clearInterval(idleTimer);
      this.peers.delete(ws);
    });
    ws.on("error", (err) => log.warn("peer socket error", { err }));
    ws.send(JSON.stringify({ type: "peer_challenge", protocolVersion: PROTOCOL_VERSION, serverNonce }));
  }

  private async answerPeer(ws: WebSocket, call: PeerCallMessage, peerApp: string | undefined): Promise<void> {
    const reply = (body: Record<string, unknown>) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "peer_result", id: call.id, ...body }));
    };
    try {
      // The pairing window names whichever app is asking right now.
      const app = call.app ?? peerApp;
      if (app && !this.session) this.setAppName(app);
      let result: unknown;
      if (call.op === "state") result = await this.state();
      else if (call.op === "wait") result = await this.waitForSession(call.timeoutMs ?? 8_000);
      else {
        if (!call.method) throw new BridgeError(ErrorCode.InvalidParams, "request needs a method");
        result = await this.request(call.method, call.params ?? {}, call.timeoutMs ?? 15_000);
      }
      reply({ ok: true, result: result ?? null });
    } catch (err) {
      const e =
        err instanceof BridgeError
          ? err
          : new BridgeError(ErrorCode.Internal, err instanceof Error ? err.message : String(err));
      reply({ ok: false, error: { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) } });
    }
  }

  private endPairing(ws: WebSocket, outcome: "accepted" | "denied" | "abandoned"): void {
    if (this.pairingInProgress?.ws !== ws) return;
    this.pairingInProgress = null;
    this.emit("pairing-ended", { outcome });
  }

  private abandonPairing(reason: string): void {
    const previous = this.pairingInProgress;
    if (!previous) return;
    this.endPairing(previous.ws, "abandoned");
    previous.ws.close(CloseCode.PairingTimeout, reason);
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
