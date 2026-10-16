// Wire protocol between the bridge (this process, WebSocket server) and the
// Recordful extension (WebSocket client in its service worker). The extension
// keeps a hand-written mirror of these shapes; bump PROTOCOL_VERSION on any
// breaking change and update docs/protocol.md alongside it.
import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const BRIDGE_PATH = "/recordful-agent-bridge/v1";
export const DEFAULT_PORT = 47823;
export const BRIDGE_HOST = "127.0.0.1";

// 1 MiB is far above any legitimate message; caps memory a rogue peer can pin.
export const MAX_MESSAGE_BYTES = 1024 * 1024;

const nonce = z.string().regex(/^[0-9a-f]{64}$/, "nonce must be 32 bytes hex");
const proof = z.string().regex(/^[0-9a-f]{64}$/, "proof must be HMAC-SHA256 hex");

// ---- handshake -------------------------------------------------------------

export const ChallengeMessage = z.object({
  type: z.literal("challenge"),
  protocolVersion: z.number().int(),
  serverNonce: nonce,
});
export type ChallengeMessage = z.infer<typeof ChallengeMessage>;

export const ClientInfo = z.object({
  extensionId: z.string().max(64),
  extensionVersion: z.string().max(32),
  browser: z.string().max(256).optional(),
});
export type ClientInfo = z.infer<typeof ClientInfo>;

export const HelloMessage = z.object({
  type: z.literal("hello"),
  protocolVersion: z.number().int(),
  clientNonce: nonce,
  proof,
  client: ClientInfo,
});
export type HelloMessage = z.infer<typeof HelloMessage>;

export const WelcomeMessage = z.object({
  type: z.literal("welcome"),
  sessionId: z.string(),
  proof,
});
export type WelcomeMessage = z.infer<typeof WelcomeMessage>;

// ---- steady state ----------------------------------------------------------

export const RequestMessage = z.object({
  type: z.literal("request"),
  id: z.string().max(64),
  method: z.string().max(64),
  params: z.record(z.string(), z.unknown()).default({}),
});
export type RequestMessage = z.infer<typeof RequestMessage>;

export const BridgeErrorPayload = z.object({
  code: z.string().max(64),
  message: z.string().max(4096),
  data: z.unknown().optional(),
});
export type BridgeErrorPayload = z.infer<typeof BridgeErrorPayload>;

export const ResponseMessage = z.discriminatedUnion("ok", [
  z.object({
    type: z.literal("response"),
    id: z.string().max(64),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    type: z.literal("response"),
    id: z.string().max(64),
    ok: z.literal(false),
    error: BridgeErrorPayload,
  }),
]);
export type ResponseMessage = z.infer<typeof ResponseMessage>;

export const EventMessage = z.object({
  type: z.literal("event"),
  name: z.string().max(64),
  data: z.unknown().optional(),
});
export type EventMessage = z.infer<typeof EventMessage>;

export const PingMessage = z.object({
  type: z.literal("ping"),
  ts: z.number(),
});
export const PongMessage = z.object({
  type: z.literal("pong"),
  ts: z.number(),
});

// Everything an authenticated client may send.
export const ClientMessage = z.union([
  ResponseMessage,
  EventMessage,
  PingMessage,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---- close codes -----------------------------------------------------------

export const CloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  BadMessage: 4400,
  AuthFailed: 4401,
  HandshakeTimeout: 4408,
  Superseded: 4409,
  HeartbeatTimeout: 4410,
  ProtocolVersion: 4426,
} as const;
