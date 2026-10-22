// Wire protocol between the bridge (this process, WebSocket server) and the
// Recordful extension (WebSocket client in its service worker). The extension
// keeps a hand-written mirror of these shapes; bump PROTOCOL_VERSION on any
// breaking change and update docs/protocol.md alongside it.
//
// v2 adds pairing: an extension that has never met this machine's bridge asks
// to pair, the user approves it in Recordful against a code the agent also
// shows, and the extension hands over a fresh secret that both sides keep.
import { z } from "zod";

export const PROTOCOL_VERSION = 2;
export const BRIDGE_PATH = "/recordful-agent-bridge/v2";
// Where a second recordful-mcp process (another AI app, the CLI) connects to
// use the first one's connection to Recordful. Never a browser: no Origin.
export const PEER_PATH = `${BRIDGE_PATH}/peer`;
export const MAX_PEERS = 16;
export const DEFAULT_PORT = 47823;
export const BRIDGE_HOST = "127.0.0.1";

// 1 MiB is far above any legitimate message; caps memory a rogue peer can pin.
export const MAX_MESSAGE_BYTES = 1024 * 1024;

const nonce = z.string().regex(/^[0-9a-f]{64}$/, "nonce must be 32 bytes hex");
const proof = z.string().regex(/^[0-9a-f]{64}$/, "proof must be HMAC-SHA256 hex");
// 32 random bytes, base64url without padding.
export const PairingSecret = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "secret must be 32 bytes base64url");

// ---- handshake -------------------------------------------------------------

// The app is the MCP client driving this bridge ("Claude Code", "Cursor"),
// so the extension can say who is asking to pair.
export const ChallengeMessage = z.object({
  type: z.literal("challenge"),
  protocolVersion: z.number().int(),
  serverNonce: nonce,
  serverId: z.string().uuid(),
  app: z.string().max(80),
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

// ---- pairing (an unpaired extension, before hello) -------------------------

export const PairRequestMessage = z.object({
  type: z.literal("pair_request"),
  protocolVersion: z.number().int(),
  client: ClientInfo,
});
export type PairRequestMessage = z.infer<typeof PairRequestMessage>;

// Sent by the server: the code the extension shows next to Allow, and the
// agent shows in chat, so the user can tell they're approving their own agent.
export const PairCodeMessage = z.object({
  type: z.literal("pair_code"),
  code: z.string().regex(/^d{4}$/),
});

// The user clicked Allow. A hello signed with the new secret follows.
export const PairAcceptMessage = z.object({
  type: z.literal("pair_accept"),
  secret: PairingSecret,
});

export const PairRejectMessage = z.object({
  type: z.literal("pair_reject"),
});

export const HandshakeMessage = z.discriminatedUnion("type", [
  HelloMessage,
  PairRequestMessage,
  PairAcceptMessage,
  PairRejectMessage,
]);
export type HandshakeMessage = z.infer<typeof HandshakeMessage>;

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

// ---- peers (other recordful-mcp processes on this machine) ------------------

export const PeerHelloMessage = z.object({
  type: z.literal("peer_hello"),
  protocolVersion: z.number().int(),
  clientNonce: nonce,
  proof,
  app: z.string().max(80).optional(),
});

export const PeerCallMessage = z.object({
  type: z.literal("peer_call"),
  id: z.string().max(64),
  op: z.enum(["state", "wait", "request"]),
  app: z.string().max(80).optional(),
  timeoutMs: z.number().int().min(1).max(30 * 60_000).optional(),
  method: z.string().max(64).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type PeerCallMessage = z.infer<typeof PeerCallMessage>;

export const PeerMessage = z.union([PeerHelloMessage, PeerCallMessage, PingMessage]);

// ---- close codes -----------------------------------------------------------

export const CloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  BadMessage: 4400,
  AuthFailed: 4401,
  HandshakeTimeout: 4408,
  Superseded: 4409,
  HeartbeatTimeout: 4410,
  PairingRejected: 4403,
  PairingTimeout: 4411,
  ProtocolVersion: 4426,
} as const;
