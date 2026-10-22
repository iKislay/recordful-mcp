// How each recordful-mcp process reaches Recordful. The first one on the
// machine owns the port (the extension connects to it); every other one (a
// second AI app, the CLI) joins it as a peer and forwards its calls. When the
// owner exits, a peer takes the port over, so nobody sees BRIDGE_UNAVAILABLE.
import type { PairingStore } from "../auth/pairings.js";
import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { BridgeError, ErrorCode } from "../protocol/errors.js";
import { BridgeServer, type Bridge, type PairingInfo, type SessionInfo } from "./BridgeServer.js";
import { PeerClient } from "./PeerClient.js";

export interface BridgeAgentOptions {
  config: BridgeConfig;
  pairings: PairingStore;
  logger: Logger;
  // false: only ever join a running owner (the CLI, which shouldn't hold the
  // extension's connection itself). Default true.
  mayOwn?: boolean;
  app?: string;
}

const RETRY_MS = 3_000;

export class BridgeAgent implements Bridge {
  private readonly opts: BridgeAgentOptions;
  private readonly log: Logger;
  private owner: BridgeServer | null = null;
  private peer: PeerClient | null = null;
  private lastError: BridgeError | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private settling: Promise<void> | null = null;
  private app: string | undefined;
  private readonly settledWaiters = new Set<() => void>();

  constructor(opts: BridgeAgentOptions) {
    this.opts = opts;
    this.log = opts.logger.child({ component: "agent" });
    this.app = opts.app;
  }

  get connection(): { mode: "owner" | "peer" | "none"; error: string | null } {
    if (this.owner?.listening) return { mode: "owner", error: null };
    if (this.peer?.open) return { mode: "peer", error: null };
    return { mode: "none", error: this.lastError?.message ?? null };
  }

  // Why the last attempt to connect failed ("NO_OWNER": nothing listens).
  get lastErrorCode(): string | null {
    return this.lastError?.code ?? null;
  }

  // The owner's server, when this process is the owner (for the idle helper).
  get server(): BridgeServer | null {
    return this.owner?.listening ? this.owner : null;
  }

  start(): Promise<void> {
    this.settling ??= this.settle().finally(() => {
      this.settling = null;
    });
    return this.settling;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.peer?.close();
    this.peer = null;
    await this.owner?.stop();
    this.owner = null;
  }

  setAppName(name: string): void {
    this.app = name;
    this.owner?.setAppName(name);
    if (this.peer) this.peer.app = name;
  }

  // Waits (briefly) for this process to be connected one way or the other.
  private async ready(timeoutMs = 4_000): Promise<BridgeServer | PeerClient> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.owner?.listening) return this.owner;
      if (this.peer?.open) return this.peer;
      if (this.stopped) throw new BridgeError(ErrorCode.BridgeUnavailable, "recordful-mcp is shutting down");
      if (Date.now() >= deadline) {
        throw this.lastError ?? new BridgeError(ErrorCode.BridgeUnavailable, "recordful-mcp couldn't reach its local port");
      }
      void this.start();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 200);
        function done() {
          clearTimeout(timer);
          resolve();
        }
        this.settledWaiters.add(done);
      });
    }
  }

  async waitForSession(timeoutMs: number): Promise<SessionInfo> {
    return (await this.ready()).waitForSession(timeoutMs);
  }

  async request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    return (await this.ready()).request(method, params, timeoutMs);
  }

  async state(): Promise<{ session: SessionInfo | null; pairing: PairingInfo | null }> {
    try {
      return await (await this.ready(1_500)).state();
    } catch {
      return { session: null, pairing: null };
    }
  }

  // ---- connection lifecycle ------------------------------------------------

  private async settle(): Promise<void> {
    if (this.stopped || this.owner?.listening || this.peer?.open) return;
    const { config, pairings } = this.opts;

    if (this.opts.mayOwn !== false) {
      const server = new BridgeServer({
        port: config.port,
        pairings,
        allowedExtensionIds: config.allowedExtensionIds,
        handshakeTimeoutMs: config.handshakeTimeoutMs,
        pairingTimeoutMs: config.pairingTimeoutMs,
        heartbeatTimeoutMs: config.heartbeatTimeoutMs,
        logger: this.opts.logger,
        peerSecret: () => pairings.peerSecret(),
      });
      if (this.app) server.setAppName(this.app);
      try {
        await server.start();
        this.owner = server;
        this.lastError = null;
        this.log.info("owns the Recordful connection", { port: config.port });
        this.notifySettled();
        return;
      } catch (err) {
        if (!(err instanceof BridgeError && err.code === ErrorCode.BridgeUnavailable)) {
          this.fail(new BridgeError(ErrorCode.BridgeUnavailable, (err as Error).message));
          return;
        }
        // The port is taken: most likely another recordful-mcp. Join it.
      }
    }

    try {
      const peer = await PeerClient.connect({
        port: config.port,
        peerSecret: () => pairings.peerSecret(),
        logger: this.opts.logger,
        ...(this.app ? { app: this.app } : {}),
      });
      this.peer = peer;
      this.lastError = null;
      this.log.info("sharing the running recordful-mcp's connection", { port: config.port });
      peer.once("close", () => {
        if (this.peer === peer) this.peer = null;
        if (!this.stopped) {
          this.log.info("the shared recordful-mcp went away; taking over");
          // A beat of jitter so several peers don't all race for the port.
          this.schedule(100 + Math.floor(Math.random() * 400));
        }
      });
      this.notifySettled();
    } catch (err) {
      const e = err instanceof BridgeError ? err : new BridgeError(ErrorCode.BridgeUnavailable, String(err));
      if (e.code === "NO_OWNER" && this.opts.mayOwn !== false) {
        // The owner exited between our two attempts: try to own again now.
        this.schedule(50);
        return;
      }
      this.fail(e);
    }
  }

  private fail(err: BridgeError): void {
    this.lastError = err;
    if (err.code !== "NO_OWNER") this.log.warn("can't reach Recordful's port yet", { err: err.message });
    this.notifySettled();
    this.schedule(RETRY_MS);
  }

  private schedule(ms: number): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.start();
    }, ms);
    this.retryTimer.unref();
  }

  private notifySettled(): void {
    for (const done of this.settledWaiters) done();
    this.settledWaiters.clear();
  }
}
