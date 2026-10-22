# Hosted MCP: `mcp.recordful.app`

The local server (`recordful-mcp` on stdio) covers AI apps that run on your machine: Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, opencode, Codex CLI and Gemini CLI. Cloud-only apps, such as claude.ai and ChatGPT connectors in the browser, can only reach an MCP server over HTTPS. This document covers that hosted server.

## Recommendation: `mcp.recordful.app`, not `recordful.app/mcp`

| | `mcp.recordful.app` | `recordful.app/mcp` |
| --- | --- | --- |
| Runtime | Its own long-running service. It holds a WebSocket to each user's extension and keeps MCP sessions open | recordful.app is Next.js on serverless hosting, which can't hold those connections |
| OAuth discovery | `/.well-known/oauth-protected-resource` at the root of its own origin, which every client handles | Needs path-suffixed metadata (RFC 9728 allows it), and some clients handle that inconsistently |
| Isolation | Deploys, scales, rate-limits and can be switched off without touching the site | Shares the site's deploys and failures |
| Convention | Matches mcp.notion.com, mcp.linear.app, mcp.stripe.com and mcp.sentry.dev | Less common |

The site doesn't move. recordful.app stays the OAuth **authorization server** (better-auth already holds the accounts), and `mcp.recordful.app` is the **resource server** that accepts its tokens.

## Architecture

```
claude.ai / ChatGPT / any remote MCP client
        │  HTTPS, Streamable HTTP + OAuth 2.1 (PKCE, dynamic client registration)
        ▼
mcp.recordful.app ── routes by user id ──► that user's Recordful extension
        ▲                                      (store build, dials wss://mcp.recordful.app/extension
        │                                       with the signed-in Recordful session token)
recordful.app (better-auth) issues and validates the OAuth tokens
```

- The tools are the same as the local server. The core in `src/core/createRecordfulServer.ts` sits behind a `RecorderTransport` interface: locally that's the loopback bridge (`src/mcp/localTransport.ts`), and when hosted it's the per-user relay.
- The extension connects only when the user has turned on "Allow AI agents" in Recordful's settings. The connection is per user and authenticated with the user's existing Recordful token, and an "Agent is controlling Recordful" badge shows while it's active.
- The click-to-arm rule still applies. Chrome requires a click on the Recordful icon before tab capture, wherever the agent runs.

## Hosting options

1. **Cloudflare Workers + Durable Objects (recommended).** One Durable Object per user holds that user's extension WebSocket and their MCP sessions, so routing a request is just looking up the user's object. Cloudflare's `agents` SDK (`McpAgent`) provides Streamable HTTP, and `workers-oauth-provider` handles the OAuth side. It scales to zero and needs no sticky sessions or Redis.
2. **A Node service** (Fly.io, Railway or Render) running this repo with the SDK's Streamable HTTP transport plus a WebSocket hub. It's simple on one instance; with more than one you need sticky routing or Redis pub/sub so a request reaches the instance holding that user's extension.

## Setup steps

1. **DNS.** Add a `CNAME` record for `mcp` pointing at the host. On Cloudflare, add `mcp.recordful.app` as a Worker Custom Domain; on Fly, run `fly certs add mcp.recordful.app`. TLS is issued automatically.
2. **Server.** Refactor the transport core, add the Streamable HTTP endpoint at `/mcp`, and add the relay endpoint `/extension` for the WebSocket.
3. **OAuth.** Turn on better-auth's OAuth/OIDC provider (with its MCP support) on recordful.app, serve `/.well-known/oauth-authorization-server` there, and serve `/.well-known/oauth-protected-resource` on mcp.recordful.app pointing at it. Use a scope such as `recording:control`.
4. **Extension.** Add a remote connector to the store build behind the "Allow AI agents" setting. This ships, unlike the dev-only local bridge. Add the consent badge and a per-session revoke.
5. **Operations.** Per-user rate limits, an audit log of agent actions on the account page, a revoke-all button, and alerts on relay errors.
6. **Publish.** Users add `https://mcp.recordful.app/mcp` as a custom connector (in claude.ai under Settings → Connectors, and similarly in ChatGPT). Later, apply to each vendor's connector directory.

The detailed design and phased plan are in [hosted-connector.md](hosted-connector.md).

## Before building it

Ship Phase 1 page tools first (see [roadmap.md](roadmap.md)). They're what let a cloud chat app with no browser of its own record a walkthrough at all, and the hosted server mainly multiplies their reach.
