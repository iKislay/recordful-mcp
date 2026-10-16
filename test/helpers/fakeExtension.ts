// A stand-in for the extension's service-worker client, speaking the real
// handshake so tests exercise the same bytes the extension sends.
import { WebSocket } from "ws";
import { computeProof, newNonce, verifyProof } from "../../src/auth/handshake.js";
import { BRIDGE_PATH, PROTOCOL_VERSION } from "../../src/protocol/messages.js";

export const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
export const TOKEN = "test-token-0123456789-abcdefghijklmnop";

export type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>;

export interface FakeExtensionOptions {
  port: number;
  token?: string;
  origin?: string;
  extensionId?: string;
  protocolVersion?: number;
  handlers?: Record<string, Handler>;
  // Skip sending hello, to exercise the handshake timeout.
  silent?: boolean;
}

export interface FakeExtension {
  ws: WebSocket;
  // Resolves with the session ID once the server proved itself, rejects with
  // the close code otherwise.
  ready: Promise<string>;
  closed: Promise<{ code: number; reason: string }>;
  serverProofValid: () => boolean;
  close: () => void;
}

export const connectFakeExtension = (opts: FakeExtensionOptions): FakeExtension => {
  const token = opts.token ?? TOKEN;
  const extensionId = opts.extensionId ?? EXTENSION_ID;
  const ws = new WebSocket(`ws://127.0.0.1:${opts.port}${BRIDGE_PATH}`, {
    origin: opts.origin ?? `chrome-extension://${extensionId}`,
  });
  const clientNonce = newNonce();
  let serverNonce = "";
  let serverProofOk = false;

  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    // Rejected upgrades surface as an error then a 1006 close.
    ws.on("error", () => {});
  });

  const ready = new Promise<string>((resolve, reject) => {
    ws.on("unexpected-response", (_req, res) => reject(new Error(`http ${res.statusCode}`)));
    void closed.then(({ code }) => reject(new Error(`closed ${code}`)));
    ws.on("message", async (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "challenge") {
        serverNonce = msg.serverNonce;
        if (opts.silent) return;
        ws.send(
          JSON.stringify({
            type: "hello",
            protocolVersion: opts.protocolVersion ?? PROTOCOL_VERSION,
            clientNonce,
            proof: computeProof(token, "client", serverNonce, clientNonce),
            client: { extensionId, extensionVersion: "0.0.0-test" },
          }),
        );
        return;
      }
      if (msg.type === "welcome") {
        serverProofOk = verifyProof(
          computeProof(token, "server", serverNonce, clientNonce),
          msg.proof,
        );
        if (serverProofOk) resolve(msg.sessionId);
        else reject(new Error("server proof invalid"));
        return;
      }
      if (msg.type === "request") {
        const handler = opts.handlers?.[msg.method];
        if (!handler) {
          ws.send(
            JSON.stringify({
              type: "response",
              id: msg.id,
              ok: false,
              error: { code: "UNKNOWN_METHOD", message: msg.method },
            }),
          );
          return;
        }
        try {
          const result = await handler(msg.params);
          ws.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result }));
        } catch (err) {
          const e = err as { code?: string; message: string };
          ws.send(
            JSON.stringify({
              type: "response",
              id: msg.id,
              ok: false,
              error: { code: e.code ?? "INTERNAL", message: e.message },
            }),
          );
        }
      }
    });
  });
  // Callers that only care about `closed` shouldn't trip unhandled rejections.
  ready.catch(() => {});

  return {
    ws,
    ready,
    closed,
    serverProofValid: () => serverProofOk,
    close: () => ws.close(1000),
  };
};
