// The hosted tools (recordful.app/mcp: editing, seeing, library, sharing,
// analytics, webhooks, account) offered here by proxy, so an AI app with only
// this server gets the whole surface without a second implementation. The
// extension carries each message with its own sign-in (cloud.mcp), so no
// credential ever reaches the bridge. Names, descriptions, schemas,
// annotations and results are the hosted server's, untouched. A local tool
// wins on a name clash: the local ones need this computer.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema, type CallToolResult, type JSONRPCMessage, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Logger } from "../logger.js";
import { Method } from "../protocol/methods.js";
import type { Call } from "../workflows.js";

// Hosted edits (silences, captions) can take a while server-side.
const HOSTED_WAIT_MS = 100_000;

/** A client transport whose every message goes to recordful.app/mcp through the extension. */
const viaExtension = (call: Call): Transport => {
  const transport: Transport = {
    start: async () => {},
    close: async () => transport.onclose?.(),
    send: async (message) => {
      const reply = await call(Method.CloudMcp, { message }, HOSTED_WAIT_MS);
      // Notifications get no reply.
      if (reply) transport.onmessage?.(reply as JSONRPCMessage);
    },
  };
  return transport;
};

// Lists as the hosted JSON Schema verbatim (zod merges .meta into its JSON
// Schema) and accepts any object: the hosted server validates.
const asIs = (schema: object) => z.looseObject({}).meta(schema as Record<string, unknown>);

/** registerTool's config for one hosted tool. */
export const proxyConfig = (tool: Tool) => ({
  title: tool.title,
  description: tool.description,
  inputSchema: asIs(tool.inputSchema),
  outputSchema: tool.outputSchema && asIs(tool.outputSchema),
  annotations: tool.annotations,
  _meta: tool._meta,
});

/**
 * Registers the hosted tools on `server` once the extension can reach
 * recordful.app. Until then (signed out, offline, a Recordful without
 * cloud.mcp) they are absent. Returns `sync`: call it whenever the extension
 * may have become reachable; it lists once, retrying after a failure.
 */
export const hostedTools = (
  server: McpServer,
  call: Call,
  fail: (err: unknown) => CallToolResult,
  version: string,
  log: Logger,
): (() => Promise<void>) => {
  let synced: Promise<void> | undefined;
  const sync = async () => {
    const client = new Client({ name: "recordful-mcp", version });
    await client.connect(viaExtension(call));
    const { tools } = await client.listTools();
    const clashes: string[] = [];
    for (const tool of tools) {
      try {
        server.registerTool(tool.name, proxyConfig(tool), async (args, extra) => {
          try {
            return await client.request(
              // _meta carries the hosted idempotency key.
              { method: "tools/call", params: { name: tool.name, arguments: args, _meta: extra._meta } },
              CallToolResultSchema,
              { timeout: HOSTED_WAIT_MS },
            );
          } catch (err) {
            return fail(err);
          }
        });
      } catch {
        // registerTool refuses a name already taken: the local tool stays.
        clashes.push(tool.name);
      }
    }
    log.info("hosted tools added", { added: tools.length - clashes.length, clashes });
  };
  return () =>
    (synced ??= sync().catch((err) => {
      synced = undefined;
      log.debug("hosted tools unavailable", { error: err instanceof Error ? err.message : String(err) });
    }));
};
