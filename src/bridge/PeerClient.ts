// A second recordful-mcp process (another AI app, the CLI) using the first
// one's connection to Recordful: it connects to the owner's peer endpoint,
// proves it shares this user's pairing file, and forwards calls.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { computeProof, newNonce, verifyProof } from "../auth/handshake.js";
import type { Logger } from "../logger.js";
import { BridgeError, ErrorCode } from "../protocol/errors.js";
import { BRIDGE_HOST, PEER_PATH, PROTOCOL_VERSION } from "../protocol/messages.js";
import type { PairingInfo, SessionInfo } from "./BridgeServer.js";

const PING_INTERVAL_MS = 20_000;
// Added to the owner's own timeout, so the owner always answers first.
const CALL_MARGIN_MS = 5_000;

export interface PeerClientOptions {
  port: number;
  peerSecret: () => Promise<string>;
  app?: string;
  logger: Logger;
  connectTimeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: BridgeError) => void;
  timer: NodeJS.Timeout;
}

export class PeerClient extends EventEmitter<{ close: [] }> {
  private readonly ws: WebSocket;
  private readonly pending = new Map<string, Pending>();
  private readonly pingTimer: NodeJS.Timeout;
  app: string | undefined;

  private constructor(ws: WebSocket, app: string | undefined) {
    super();
    this.ws = ws;
    this.app = app;
    ws.on("message", (raw) => this.onMessage(raw.toString()));
    // A socket error is followed by close, which is what we act on.
    ws.on("error", () => {});
    ws.on("close", () => {
      clearInterval(this.pingTimer);
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new BridgeError(ErrorCode.Disconnected, "the recordful-mcp process this one shared went away"));
        this.pending.delete(id);
      }
      this.emit("close");
    });
    this.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
    }, PING_INTERVAL_MS);
    this.pingTimer.unref();
  }

  // Resolves once the owner proved itself. Rejects with code "NO_OWNER" when
  // nothing listens on the port, so the caller can become the owner instead.
  static connect(opts: PeerClientOptions): Promise<PeerClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${BRIDGE_HOST}:${opts.port}${PEER_PATH}`, {
        handshakeTimeout: opts.connectTimeoutMs ?? 3_000,
      });
      const clientNonce = newNonce();
      let settled = false;
      const timer = setTimeout(() => fail(new BridgeError(ErrorCode.BridgeUnavailable, "timed out joining the running recordful-mcp")), opts.connectTimeoutMs ?? 5_000);
      const fail = (err: BridgeError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.removeAllListeners();
        ws.on("error", () => {});
        ws.terminate();
        reject(err);
      };
      ws.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ECONNREFUSED") fail(new BridgeError("NO_OWNER", "no recordful-mcp is running"));
        else fail(new BridgeError(ErrorCode.BridgeUnavailable, `couldn't join the running recordful-mcp: ${err.message}`));
      });
      ws.on("unexpected-response", (_req, res) => {
        fail(
          new BridgeError(
            ErrorCode.BridgeUnavailable,
            res.statusCode === 404
              ? `Port ${opts.port} is used by an older recordful-mcp or another program. Update recordful-mcp, or close the other program.`
              : `the running recordful-mcp refused this one (HTTP ${res.statusCode})`,
          ),
        );
      });
      ws.on("close", (code) => {
        fail(
          new BridgeError(
            ErrorCode.BridgeUnavailable,
            code === 4401
              ? "the running recordful-mcp uses a different pairing file (another user, or RECORDFUL_BRIDGE_STATE_PATH differs)"
              : code === 4426
                ? "the running recordful-mcp is a different version; update both"
                : `the running recordful-mcp closed the connection (${code})`,
          ),
        );
      });
      ws.on("message", async (raw) => {
        let msg: { type?: string; serverNonce?: string; proof?: string; protocolVersion?: number };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return fail(new BridgeError(ErrorCode.BridgeUnavailable, "the running recordful-mcp sent garbage"));
        }
        try {
          if (msg.type === "peer_challenge" && typeof msg.serverNonce === "string") {
            const secret = await opts.peerSecret();
            ws.send(
              JSON.stringify({
                type: "peer_hello",
                protocolVersion: PROTOCOL_VERSION,
                clientNonce,
                proof: computeProof(secret, "peer", msg.serverNonce, clientNonce),
                ...(opts.app ? { app: opts.app } : {}),
              }),
            );
            (ws as WebSocket & { serverNonce?: string }).serverNonce = msg.serverNonce;
            return;
          }
          if (msg.type === "peer_welcome") {
            const serverNonce = (ws as WebSocket & { serverNonce?: string }).serverNonce ?? "";
            const secret = await opts.peerSecret();
            if (!verifyProof(computeProof(secret, "peer-server", serverNonce, clientNonce), msg.proof ?? "")) {
              return fail(new BridgeError(ErrorCode.BridgeUnavailable, "the process on the port couldn't prove it is this user's recordful-mcp"));
            }
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            ws.removeAllListeners();
            resolve(new PeerClient(ws, opts.app));
          }
        } catch (err) {
          fail(new BridgeError(ErrorCode.BridgeUnavailable, (err as Error).message));
        }
      });
    });
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.ws.close(1000, "done");
  }

  private onMessage(text: string): void {
    let msg: { type?: string; id?: string; ok?: boolean; result?: unknown; error?: { code: string; message: string; data?: unknown } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type !== "peer_result" || !msg.id) return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.ok) pending.resolve(msg.result);
    else pending.reject(new BridgeError(msg.error?.code ?? ErrorCode.Internal, msg.error?.message ?? "failed", msg.error?.data));
  }

  private call(op: "state" | "wait" | "request", body: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (!this.open) {
      return Promise.reject(new BridgeError(ErrorCode.Disconnected, "the recordful-mcp process this one shared went away"));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(ErrorCode.Timeout, `${op} timed out after ${timeoutMs}ms`));
      }, timeoutMs + CALL_MARGIN_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ type: "peer_call", id, op, ...(this.app ? { app: this.app } : {}), ...body }));
    });
  }

  state(): Promise<{ session: SessionInfo | null; pairing: PairingInfo | null }> {
    return this.call("state", {}, 5_000) as Promise<{ session: SessionInfo | null; pairing: PairingInfo | null }>;
  }

  waitForSession(timeoutMs: number): Promise<SessionInfo> {
    return this.call("wait", { timeoutMs }, timeoutMs) as Promise<SessionInfo>;
  }

  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    return this.call("request", { method, params, timeoutMs }, timeoutMs);
  }
}
