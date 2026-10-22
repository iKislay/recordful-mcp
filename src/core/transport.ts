// What the MCP core needs from whatever carries requests to the extension.
// Locally that's the loopback bridge (src/mcp/localTransport.ts); hosted at
// mcp.recordful.app it's the per-user relay. The core never sees which, so
// the tools, the prompt and the result shapes are the same everywhere.
//
// Everything under src/core (and the protocol/ and workflows modules it uses)
// must run outside Node too: no node:* imports and no Node globals.
// test/core.test.ts enforces it.

export interface TransportStatus {
  // An extension is attached and can take requests right now.
  connected: boolean;
  // Shown to the agent as get_status's `bridge` block.
  detail: Record<string, unknown>;
  // What to tell the user when nothing is attached.
  hint?: string;
}

export interface RecorderTransport {
  // Waits up to timeoutMs for an extension to be attached. Rejects with the
  // transport's own BridgeError (NOT_CONNECTED, PAIRING_PENDING, ...) and hint.
  ready(timeoutMs: number): Promise<void>;
  // One request/response with the extension: protocol v2 method names and params.
  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
  status(): Promise<TransportStatus>;
}

// Text that differs between transports: local talks about pairing codes and
// localhost; hosted about signing in and apps the user's browser can reach.
export interface ServerCopy {
  instructions: string;
  recordFeaturePrompt: (feature: string, url?: string) => string;
}

export interface Timeouts {
  // How long a tool call waits for the extension to (re)connect.
  connectWaitMs: number;
  // Base time a request may take, before each tool's own extra allowance.
  requestTimeoutMs: number;
}
