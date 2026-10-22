// The loopback bridge as a RecorderTransport: waits and requests go straight
// to Bridge (an owned BridgeServer or a peer of the process that owns it),
// and get_status's `bridge` block keeps the shape it has always had.
import type { Bridge } from "../bridge/BridgeServer.js";
import type { RecorderTransport } from "../core/transport.js";

export const localTransport = (bridge: Bridge): RecorderTransport => ({
  ready: async (timeoutMs) => {
    await bridge.waitForSession(timeoutMs);
  },
  request: (method, params, timeoutMs) => bridge.request(method, params, timeoutMs),
  status: async () => {
    const { session, pairing } = await bridge.state();
    const { mode, error } = bridge.connection;
    return {
      connected: session !== null,
      detail: {
        // owner: this process holds Recordful's connection; peer: it shares
        // another recordful-mcp's (another AI app or the CLI started first).
        mode,
        error,
        extensionConnected: session !== null,
        session,
        pairing: pairing ? { code: pairing.code, app: pairing.app, startedAt: pairing.startedAt } : null,
      },
      hint: pairing
        ? `Recordful is waiting for the user to approve this app. Ask them to check the code ${pairing.code} and click Allow.`
        : "Ask the user to click the Recordful toolbar icon in Chrome on the tab to record. The first time only, they also turn on AI agents (Recordful popup → More → AI agents).",
    };
  },
});
