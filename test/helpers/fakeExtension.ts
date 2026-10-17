// A stand-in for the extension's service-worker client, speaking the real
// handshake so tests exercise the same bytes the extension sends.
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { computeProof, newNonce, verifyProof } from "../../src/auth/handshake.js";
import { BRIDGE_PATH, PROTOCOL_VERSION } from "../../src/protocol/messages.js";

export const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
export const TOKEN = "test-token-0123456789-abcdefghijklmnop";
export const SERVER_ID = "6f1c2b9a-0d4e-4c3b-9a7e-1f2d3c4b5a69";

// In-memory pairing store; EXTENSION_ID starts paired with TOKEN.
export const memoryPairings = (initial: Record<string, string> = { [EXTENSION_ID]: TOKEN }) => {
  const secrets = new Map(Object.entries(initial));
  return {
    serverId: SERVER_ID,
    secrets,
    secretsFor: async (id: string) => (secrets.has(id) ? [secrets.get(id) as string] : []),
    save: async (id: string, secret: string) => {
      secrets.set(id, secret);
    },
  };
};

export type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>;

export interface FakeExtensionOptions {
  port: number;
  // The secret to sign hello with; null means unpaired, so it asks to pair.
  token?: string | null;
  // What the "user" does with the pairing prompt.
  pairing?: "accept" | "reject" | "ignore";
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
  // The code the server sent for the pairing prompt.
  pairCode: Promise<string>;
  challenge: Promise<{ serverId: string; app: string }>;
  close: () => void;
}

export const connectFakeExtension = (opts: FakeExtensionOptions): FakeExtension => {
  let token = opts.token === undefined ? TOKEN : opts.token;
  let resolveCode: (code: string) => void = () => {};
  const pairCode = new Promise<string>((resolve) => (resolveCode = resolve));
  let resolveChallenge: (c: { serverId: string; app: string }) => void = () => {};
  const challenge = new Promise<{ serverId: string; app: string }>((resolve) => (resolveChallenge = resolve));
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
      const sendHello = (secret: string) =>
        ws.send(
          JSON.stringify({
            type: "hello",
            protocolVersion: opts.protocolVersion ?? PROTOCOL_VERSION,
            clientNonce,
            proof: computeProof(secret, "client", serverNonce, clientNonce),
            client: { extensionId, extensionVersion: "0.0.0-test" },
          }),
        );
      if (msg.type === "pair_code") {
        resolveCode(msg.code);
        if (opts.pairing === "reject") ws.send(JSON.stringify({ type: "pair_reject" }));
        if (opts.pairing === "accept") {
          token = randomBytes(32).toString("base64url");
          ws.send(JSON.stringify({ type: "pair_accept", secret: token }));
          sendHello(token);
        }
        return;
      }
      if (msg.type === "challenge") {
        serverNonce = msg.serverNonce;
        resolveChallenge({ serverId: msg.serverId, app: msg.app });
        if (opts.silent) return;
        if (token === null) {
          ws.send(
            JSON.stringify({
              type: "pair_request",
              protocolVersion: opts.protocolVersion ?? PROTOCOL_VERSION,
              client: { extensionId, extensionVersion: "0.0.0-test" },
            }),
          );
          return;
        }
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
          computeProof(token as string, "server", serverNonce, clientNonce),
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
    pairCode,
    challenge,
    close: () => ws.close(1000),
  };
};
