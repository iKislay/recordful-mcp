// Only one process can own the bridge port. When two MCP clients each launch
// recordful-mcp, the second keeps retrying so it takes over the moment the
// first exits, and its tools report why they can't reach the extension.
import type { Logger } from "../logger.js";
import type { BridgeServer } from "./BridgeServer.js";

export interface BindSupervisor {
  readonly lastError: Error | null;
  stop(): void;
}

export const keepBound = (
  server: BridgeServer,
  intervalMs: number,
  logger: Logger,
): BindSupervisor => {
  let lastError: Error | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let warned = false;

  const attempt = async () => {
    if (stopped || server.listening) return;
    try {
      await server.start();
      lastError = null;
      warned = false;
    } catch (err) {
      lastError = err as Error;
      if (!warned) {
        logger.warn("bridge bind failed, will keep retrying", { err });
        warned = true;
      }
      if (!stopped) {
        timer = setTimeout(attempt, intervalMs);
        timer.unref();
      }
    }
  };
  void attempt();

  return {
    get lastError() {
      return lastError;
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
};
