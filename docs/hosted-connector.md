# Hosted connector: `mcp.recordful.app` (design)

Status: **draft for approval**. Nothing here is built yet. It refines [remote-mcp.md](remote-mcp.md) into a buildable design and a phased plan, and ends with the questions that need an answer before Phase 1 starts.

## Goal

Cloud-only AI apps can drive Recordful the way local apps already do through `recordful-mcp` on stdio:

- claude.ai (web, desktop app's cloud connectors, mobile), including Claude Team/Enterprise org-wide connectors
- ChatGPT connectors (Developer Mode / Apps)
- Claude Code on the web, Cursor background agents and other agents that run in someone else's cloud

The user adds one URL, `https://mcp.recordful.app/mcp`, signs in to Recordful once, and approves the app. Everything else (tools, the `record_feature` prompt, the cursor, click-to-arm) is the same as local.

### Non-goals

- Recordings never pass through `mcp.recordful.app`. They stay in the browser and reach recordful.app only through the existing upload path, when the user saves one.
- No new tools. Phase 2 editor tools will arrive on both transports at once, because they share a core.
- No headless or server-side browser. The agent drives the user's own Chrome, which must be open, signed in to Recordful, and handed a tab by the user.

## Architecture

```
 claude.ai / ChatGPT / Cursor / Claude Code (web)
        │  HTTPS: MCP Streamable HTTP, OAuth 2.1 bearer (JWT, aud = https://mcp.recordful.app/mcp)
        ▼
 ┌──────────────────────── mcp.recordful.app (Cloudflare Worker) ─────────────────────────┐
 │  /.well-known/oauth-protected-resource   /mcp   /extension   /internal/*   /healthz    │
 │        │ verify JWT (JWKS from recordful.app), route by sub ─► UserRelay Durable Object  │
 │        │                                                     (one per Recordful user)  │
 │        │                                        holds the extension WebSocket,         │
 │        │                                        forwards requests, rate-limits, audits │
 └────────┼───────────────────────────────────────────────┬───────────────────────────────┘
          │ OAuth discovery, authorize, token, JWKS        │ wss, same request/response frames as protocol v2
          ▼                                                ▼
 recordful.app (recordful-ee, Next.js 16, better-auth)   Recordful extension (store build) in the user's Chrome
   authorization server, consent page, account page,       "Allow cloud AI apps" on, signed in to Recordful,
   relay tokens for the extension, audit log storage       dials out after the user clicks the Recordful icon
```

Three changes, one per repo:

| Repo | Change |
| --- | --- |
| recordful-agent-bridge (`recordful-mcp`) | Split the MCP surface into a runtime-agnostic core over a `RecorderTransport` interface; add `hosted/`, the Worker |
| recordful-ee (recordful.app) | Become an OAuth 2.1 authorization server (better-auth `mcp` + `jwt` plugins), consent page, relay-token endpoint, "AI apps" on the account page |
| recordful (extension) | A remote connection next to the local one, behind AI agents + a separate "Allow cloud AI apps" consent; per-app approval in this browser |

## 1. Transport-agnostic core

Today `createMcpServer` takes a `BridgeServer` and a `BindSupervisor` and reads their state directly (`bridge.listening`, `bridge.currentSession`, `bridge.pairing`, `binding.lastError`). Everything else in it (tool schemas, `pageCall`, error shaping, the screenshot image block, the prompt) is transport-neutral.

### Interface

```ts
// src/core/transport.ts
export interface RecorderTransport {
  // Waits up to timeoutMs for an extension to be attached. Rejects with the
  // transport's own BridgeError (NOT_CONNECTED, PAIRING_PENDING, BRIDGE_UNAVAILABLE,
  // APPROVAL_PENDING, ...) and its own hint text.
  ready(timeoutMs: number): Promise<void>;
  // One request/response with the extension. Same method names and params as protocol v2.
  request(method: Method, params: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
  // The `bridge` block of get_status, plus the hint to show when nothing is attached.
  describe(): Promise<{ connected: boolean; detail: Record<string, unknown>; hint?: string }>;
}

export interface ServerCopy {
  instructions: string;                                 // INSTRUCTIONS today
  recordFeaturePrompt: (feature: string, url?: string) => string;
}

export interface McpServerDeps {
  transport: RecorderTransport;
  copy: ServerCopy;
  timeouts: { connectWaitMs: number; requestTimeoutMs: number };
  logger: Logger;          // interface only; no node:process inside core
  version: string;
}
```

- `LocalTransport` (in `src/local/`) wraps `BridgeServer` + `BindSupervisor` and produces exactly today's errors, hints and `get_status` output. It is a move, not a rewrite: `call()`'s listening check and `waitForSession` become `ready()`.
- `RelayTransport` (in `hosted/`) is constructed per MCP request with the caller's user id and OAuth client, and calls the user's Durable Object over RPC.
- `copy` exists because the text differs: local talks about pairing codes and `localhost`; hosted talks about "Allow cloud AI apps", signing in to the same Recordful account, per-app approval, and that **the app being demoed must be reachable from the user's browser** (a preview or production URL, not `localhost` inside a cloud sandbox such as Claude Code on the web). Shared paragraphs live in one place and are composed.

### Layout (as built in Phase 1)

```
src/core/      createRecordfulServer.ts (every tool + the record_feature prompt), transport.ts
               (RecorderTransport, ServerCopy, Timeouts), videoTools.ts
src/protocol/, src/workflows.ts
               also runtime-agnostic: the core imports them
src/mcp/       createMcpServer.ts: the local server = core + localTransport (over Bridge) + the local copy
src/bridge/, src/auth/, src/cli.ts ...
               Node-only, unchanged
hosted/        Cloudflare Worker (Phase 3): its own package.json + wrangler.jsonc, imports ../src/core
```

`test/core.test.ts` enforces the boundary: no `node:` imports or Node globals in the core files, and their runtime imports stay inside that set (type-only imports, like `Logger`, may point anywhere). It also runs the tools through a fake transport with hosted-style copy.

The design first proposed moving `bridge/`, `auth/` and `cli.ts` under `src/local/`. That was dropped: it would move the published bin path and break doc links for no gain, since 0.4 already put a `Bridge` interface in front of BridgeServer/BridgeAgent/PeerClient. `src/mcp/createMcpServer.ts` keeps its exports (`createMcpServer`, `McpServerDeps`, `recordFeaturePrompt`), so `cli.ts` and the existing tests didn't change.

### SDK version

The local server uses `@modelcontextprotocol/sdk` 1.x. The current better-auth MCP docs target the 2026-07-28 MCP revision and SDK v2 (`@modelcontextprotocol/server`). The core should run on one SDK for both transports. Plan: do the core refactor on 1.x (no behaviour change), then move core + local + hosted to v2 together in Phase 3, once Phase 0's spike confirms the clients we care about negotiate it. If they don't yet, the Worker serves 1.x's web-standard Streamable HTTP transport, which runs on Workers.

## 2. Hosted server

### Endpoints on `mcp.recordful.app`

| Path | What |
| --- | --- |
| `POST /mcp` (and `GET`/`DELETE` per Streamable HTTP) | MCP endpoint. Requires `Authorization: Bearer <access token>`; otherwise `401` with `WWW-Authenticate: Bearer resource_metadata="https://mcp.recordful.app/.well-known/oauth-protected-resource/mcp", scope="recording:control"` |
| `GET /.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` | RFC 9728 metadata: `resource: "https://mcp.recordful.app/mcp"`, `authorization_servers: ["https://recordful.app/api/auth"]`, `scopes_supported: ["recording:control"]`, `bearer_methods_supported: ["header"]`, `resource_name: "Recordful"` |
| `GET /extension` (WebSocket upgrade) | The extension's relay connection (below). `Origin` must be `chrome-extension://hkcgjbkibidgbefehehenlmhjanjaopc` (plus a dev allowlist on staging only) |
| `POST /internal/revoke`, `GET /internal/status` | Called by recordful.app only (HMAC-signed with a shared secret, or a Cloudflare service binding if recordful.app ever moves there): revoke a client or a whole user; list a user's connected browsers for the account page |
| `GET /healthz` | Liveness, no details |
| `GET /` | Redirect to recordful.app/docs/ai (the setup page) |

### MCP requests

The MCP endpoint is **stateless**: each request verifies the JWT and handles that one JSON-RPC message with a `RelayTransport` for `{userId: sub, clientId: client_id/azp, app: client name}`. The `McpServer` (tool schemas, prompt) is built once per isolate, not per request, to stay inside the free plan's 10 ms CPU budget; the per-request caller reaches the shared server through `AsyncLocalStorage` (available with `nodejs_compat`), and the RelayTransport resolves it per call. No MCP session state, so it needs no sticky routing and survives deploys. Long calls (`start_recording` waits up to 120 s) are just a long-lived request that awaits I/O; Workers don't bill CPU time while waiting.

Token verification (in the Worker, no call to recordful.app per request):

- signature against recordful.app's JWKS (`https://recordful.app/api/auth/jwks`, cached, refreshed on unknown `kid`)
- `iss` = `https://recordful.app/api/auth`, `aud` contains `https://mcp.recordful.app/mcp`, `exp`/`nbf`, `scope` contains `recording:control`
- the `(sub, client_id)` pair is not on the user's DO revocation list (see Security)

### UserRelay Durable Object (one per user, id = `idFromName(sub)`)

- Holds at most one extension WebSocket (a newer one supersedes the old with close `4409`, exactly like local), using the **WebSocket Hibernation API** so an idle but connected extension costs no duration.
- The extension's 20 s heartbeat becomes a fixed `{"type":"ping"}` frame answered by `setWebSocketAutoResponse` with `{"type":"pong"}`, which does not wake the object. Heartbeat timeout (65 s) is checked from `getWebSocketAutoResponseTimestamp` in an alarm. The ping still does its real job, keeping the MV3 worker alive.
- `request(method, params, timeoutMs, caller)` RPC from the Worker: rate-limit check → send `{type:"request", id, method, params, caller:{clientId, app}}` → await the matching response or time out → write an audit record → return. Pending requests live in memory (a hibernated object has none in flight by definition).
- Per-user serialization comes free (a DO is single-threaded); the extension's own `recorder`/`page` queues still order the actual work.
- Holds the user's revoked `client_id`s (with expiry = longest possible token lifetime) and a `disabled` flag pushed by recordful.app.
- Batches audit records and flushes them to recordful.app (`POST /api/internal/agent-audit`, HMAC-signed) every 30 s from its alarm (not from `webSocketClose`, which doesn't run when a deploy restarts the object).

### Extension relay protocol (`/extension`)

The steady state is protocol v2's frames unchanged (`request`/`response`/`event`/`ping`/`pong`), so `commands.js` and `pageCommands.js` don't change. Only the handshake differs, because TLS authenticates the server and the user is authenticated by recordful.app:

```
server → client  {type:"challenge", protocolVersion:2, relay:true, serverNonce}
client → server  {type:"hello", protocolVersion:2, token:<relay JWT>, client:{extensionId, extensionVersion, browser, installId}}
server → client  {type:"welcome", sessionId, user:{id}}
client → server  {type:"reauth", token}            every 10 min (relay tokens live 15 min)
server → client  {type:"request", id, method, params, caller:{clientId, app}}
```

- The relay JWT comes from recordful.app (`POST /api/agent/relay-token`, authenticated with the extension's existing `recordfulToken` bearer session). It is short-lived and narrow: `aud: "https://mcp.recordful.app/extension"`, `scope: "relay:extension"`, `sub: userId`, `sid: sessionId`, 15 min. **The better-auth session token itself never goes to mcp.recordful.app**, and the token is never in the URL.
- New close codes: `4412` revoked (user turned cloud AI off on the account page, or signed out), `4413` idle (no requests for 20 min), `4429` rate limited. Existing ones (`4400`, `4401`, `4408`, `4409`, `4410`, `4426`) keep their meaning.
- New error codes for agents (additive, per the codes contract): `APPROVAL_PENDING` (with `data.app`), `APPROVAL_DENIED`, `RATE_LIMITED` (with `data.retryAfterMs`), `CLOUD_DISABLED`.
- Frames stay ≤ 1 MiB; screenshots already fit (≤ 900 KB base64).

### Hosting recommendation: Cloudflare Workers + Durable Objects

| | Cloudflare Workers + Durable Objects (recommended) | Node service (Fly.io / Railway / Render) |
| --- | --- | --- |
| Routing a user to their extension | Built in: `idFromName(userId)` finds the one object holding that socket, from any edge | Trivial on one instance. On more than one: Fly's `fly-replay` to the owning machine, or Redis pub/sub, plus a user → machine registry |
| Idle connections | Hibernation + auto-response pings: connected-but-idle extensions cost ~nothing | Each socket holds memory on a VM that runs 24/7 |
| Deploys | A code update restarts Durable Objects and drops their sockets (seen in the Phase 0 spike); extensions reconnect within their 80 s retry window. Stateless `/mcp` requests are unaffected | Every deploy drops every socket the same way, and in-flight MCP requests too unless draining is built |
| Cost, small scale | **$0 on Workers Free** (SQLite Durable Objects included: 100k DO requests/day; over the limit calls fail, no bill). Paid is $5/month minimum, which includes 10 M Worker requests and 1 M DO requests + 400k GB-s; well within that for thousands of users | ~$5–10/month for one small always-on VM; HA (2 regions) doubles it and needs the routing above |
| Cost, growth | Linear in tool calls (DO requests $0.15/M beyond the included amount); no idle floor | Step function per VM; cheap until you need a second instance, then the routing work |
| Code reuse | The core runs as is; the relay is new code (~400 lines); `ws`-library code from `BridgeServer` doesn't carry over | Reuses `BridgeServer`'s `ws` code nearly verbatim |
| Ops | No servers, TLS and DDoS handled, logs via Workers Logs/Logpush | You own patching, scaling, health checks, TLS renewal (automatic on Fly) |
| Lock-in | DO is Cloudflare-specific (the relay is small enough to port) | Portable |
| DNS | Workers Custom Domain; the recordful.app zone is already on Cloudflare | A `CNAME` from any DNS provider |

Cloudflare's `agents` SDK is optional here: we use its `createMcpHandler` (Streamable HTTP for a plain `McpServer`) if it fits, but not `McpAgent` (a DO per MCP session) or `workers-oauth-provider` (which makes the Worker the authorization server; ours is recordful.app). JWT checks use `jose`.

## 3. Authorization server on recordful.app

better-auth 1.7.7 is installed with `bearer()` and `organization()`. Bump it to **1.7.12** (the `@better-auth/mcp`/`cimd` peer requirement; Phase 0 confirmed 1.8 isn't needed, see [hosted-phase-0-findings.md](hosted-phase-0-findings.md)) and add:

- **`jwt()`** (from `better-auth/plugins`): the signing key and `GET /api/auth/jwks`. Access tokens and relay tokens are JWTs, so the Worker never calls back per request.
- **`mcp({ resource: "https://mcp.recordful.app/mcp", loginPage: "/login", consentPage: "/oauth/consent", scopes: ["recording:control", "offline_access"], ... })`** from `@better-auth/mcp`, which wraps the OAuth 2.1 provider: authorization code + **PKCE (S256 only)**, public clients (`token_endpoint_auth_method: none`), resource-bound tokens (RFC 8707), refresh tokens. Set `grantTypes: ["authorization_code", "refresh_token"]`; the default also advertises `client_credentials`.
- **Client registration, both ways**, because clients differ:
  - **CIMD** (`@better-auth/cimd`, `metadataProfile: "mcp-2026-07-28"`, the Node fetcher with its SSRF rules): Claude uses it when the AS metadata advertises `client_id_metadata_document_supported` and `none` auth. No row per connection, and the client's name comes from a document on its own domain (claude.ai), which is what the consent page shows.
  - **DCR** (`allowDynamicClientRegistration: true`, unauthenticated): ChatGPT and Cursor register dynamically. Rate-limited per IP through the existing Postgres limiter; clients never used within 30 days are deleted by an Inngest cron.
- **Discovery**: the issuer is `https://recordful.app/api/auth`. better-auth serves AS metadata (RFC 8414) at `/api/auth/.well-known/oauth-authorization-server`. The issuer-inserted path `https://recordful.app/.well-known/oauth-authorization-server/api/auth` (and the `openid-configuration` twin) falls outside the `[...all]` route, so it needs its own Next.js route handler forwarding to `auth.handler`. Serving the same document at the bare `/.well-known/oauth-authorization-server` too helps clients that skip path insertion.
- **Token lifetimes** (proposal): access 10 min, refresh 30 days sliding with rotation (`refreshTokenReuseInterval` 30 s default), consent remembered until revoked.
- **Consent page** `/oauth/consent` (new, in the site's design): the app's name and domain, the Recordful account it will act for, and in plain words what `recording:control` allows: *start, pause and stop recordings in your Chrome, and read, click and type on the tab you hand to Recordful; screenshots and page text go to this app.* Allow / Cancel.
- **Relay-token endpoint** `POST /api/agent/relay-token` (bearer session auth, POST only, CORS for the extension origin like `/api/auth/refresh`): refuses with 403 when the user has turned cloud AI apps off for their account; signs the relay JWT with the same key via `auth.api.signJWT`, setting `iss: "https://recordful.app/api/auth"` explicitly (the default is the bare origin).
- **Internal endpoints** `POST /api/internal/agent-audit` (from the Worker) and an outbound `revoke` call to the Worker whenever a grant is revoked, the account switch is turned off, the user signs out everywhere, or the account is deleted (`closeAccount`).
- **Schema**: the plugins' tables (`jwks`, OAuth clients, consents, refresh tokens) generated with the better-auth CLI into `lib/db/auth-schema.ts` and migrated with drizzle-kit; plus `agent_audit_events` and a `user.agentCloudDisabled` field (`input: false`).

`bearer()` keeps working as today: OAuth access tokens are JWTs that never match a session row, so they can't be used as sessions against recordful.app, and the Worker never accepts session tokens.

## 4. Extension

### Settings and consent

AI agents page (`agents.html`), under the existing **AI agents** switch:

- **Allow cloud AI apps** (new, off by default, only enabled when AI agents is on): *"Let AI apps you've connected at recordful.app (claude.ai, ChatGPT, …) control Recordful in this browser after you click the Recordful icon. Commands, page text and screenshots go through mcp.recordful.app; recordings don't."* Needs the user signed in to Recordful; if not, the row shows **Sign in** (the existing `loginWithWebsite` flow).
- **Cloud apps in this browser**: each app that has asked here (from `agentBridgeCloudApprovals`), with *Remove*. Link: *Manage on recordful.app* (the account page, where revoking the grant lives).

Storage (`storageKeys.js`): `agentBridgeCloudEnabled` (local), `agentBridgeCloudApprovals` (local, `{[clientId]: {app, approvedAt}}`), `agentBridgeCloudStatus` (session).

### Per-app approval in this browser

OAuth consent happens on recordful.app for the account. An account can be signed in on several browsers (a work laptop, a shared machine), so the first time a given OAuth client sends a command to *this* browser, the extension answers `APPROVAL_PENDING` and opens the existing pairing window in a code-less variant: *"Claude (claude.ai) wants to control Recordful in this browser. Allow / Deny."* The agent's copy tells the user to click Allow and retries. Same shape as local pairing, so users and agents already know it.

### Connection

`client.js` splits into three pieces sharing one dispatcher:

- `dispatcher.js`: `runCommand` with the `recorder`/`page` queues, response shaping, status and badge. **Shared** by both connections, so a local agent and a cloud agent can't run two page actions at once.
- `localConnection.js`: today's loopback + HMAC pairing code, unchanged in behaviour.
- `remoteConnection.js`: `wss://mcp.recordful.app/extension` (staging URL in dev builds via `RECORDFUL_AGENT_RELAY_URL`), relay-token fetch and reauth, approval check on `caller.clientId`.

When it dials: on the same gestures as local (icon click, shortcut, turning the setting on), one attempt per gesture, plus resume on worker boot if a session was live. After a dropped session it retries like local (6 tries, ~80 s). Unlike the local server, the relay is always up, so the extension **closes after 20 minutes without a request** (`4413`) to stop keeping the worker alive forever; the next icon click reconnects. Signing out of Recordful or turning either switch off closes it.

### Same rules as local, tightened for remote

- **Click-to-arm**: page tools only act on the armed tab or the tab being recorded (unchanged).
- **Recording starts need presence**: today `screen` and camera modes don't need an armed tab (screen mode has Chrome's picker; camera mode has nothing). For calls arriving over the remote connection, `recording.start` in any mode requires an armed tab from the current connection, so a cloud agent can never start a camera recording on its own long after the user walked away.
- **Badge**: the same "AI" badge; the title names the app and says *via recordful.app*. The popup shows **Stop agent**, which closes both connections and clears the armed tab (this is also Phase 1's open "stop button" item).

### Chrome Web Store

The store build already contains the local bridge. The remote connection sends page content to our server when the user opts in, so before release: update the privacy policy and the CWS "data usage" disclosures (website content, user activity; Limited Use), and describe the setting in the listing. No new manifest permissions: `host_permissions` is already `<all_urls>` and the CSP has no `connect-src` restriction.

## 5. Security

| Topic | Design |
| --- | --- |
| Per-user routing | The DO is chosen only from the verified JWT `sub` (MCP side) or the verified relay JWT `sub` (extension side). Nothing in a request body can name another user. DO ids are derived server-side and never exposed |
| Two consents + presence | OAuth consent per app per account (recordful.app) → per-app approval per browser (extension) → a click on the Recordful icon per session (Chrome's own rule, plus our arming rule) |
| Revocation | Account page: revoke one app (deletes its consent **and** revokes its refresh tokens explicitly, since better-auth's `delete-consent` leaves them working; pushes `revoke(sub, clientId)` to the DO, which rejects that client's in-flight and future calls until its last access token expires) or **turn off cloud AI apps** for the account (pushes `disable(sub)`, closes the extension socket with `4412`, relay-token endpoint refuses). Extension: Remove an app, Stop agent, or turn the switch off |
| Token handling | Access tokens: 10 min JWT, audience-bound to `/mcp`. Relay tokens: 15 min, audience-bound to `/extension`. Session tokens never leave the extension ↔ recordful.app path. No tokens in URLs or logs |
| Rate limits (proposal) | Per user in the DO: 10 concurrent requests, 600 tool calls/hour, 60 screenshots/10 min, 30 extension connects/hour. Per IP at recordful.app: DCR 10/hour, token endpoint per better-auth's limiter. Exceeding → `RATE_LIMITED` with `retryAfterMs` |
| Audit log | One row per tool call: time, user, OAuth client + app name, method, outcome (ok or error code), duration, target tab's **hostname only**, browser install id. Never params, typed text, URLs' paths, snapshots or screenshots. Kept 90 days, shown on the account page, deleted with the account |
| What transits the server | MCP requests and responses: tool arguments (URLs, text to type), page snapshots (element roles/names/values, with password values already masked by the content script), screenshots (JPEG). Held in memory only for the life of the request; never stored, never logged. **Recordings never transit** |
| Logs | Worker logs carry method, size, latency, error code, user id hash. Payload logging is impossible by construction (the relay forwards opaque strings) |
| Abuse of DCR/CIMD | CIMD fetches follow better-auth's SSRF rules; DCR is rate-limited and garbage-collected; consent shows the redirect URI's host for DCR clients so a look-alike name can't hide where tokens go |
| Prompt injection | Pages the agent reads can carry instructions aimed at the agent. Our mitigations are structural: one armed tab, presence for starts, visible cursor and badge, Stop agent. The hosted `copy` repeats "use test data only, never the user's real credentials" |

## 6. Rollout

### DNS and TLS

The recordful.app zone is on Cloudflare (the site itself stays on Vercel), so add `mcp.recordful.app` as a Workers Custom Domain on the Worker; that creates the DNS record and the certificate. Same for `mcp-staging.recordful.app`. Existing records for the site are untouched.

### Registering the connector

| Client | Steps | Notes |
| --- | --- | --- |
| claude.ai (Pro/Max) | Settings → Connectors → Add custom connector → name *Recordful*, URL `https://mcp.recordful.app/mcp` → Connect → Recordful sign-in → consent | Redirect `https://claude.ai/api/mcp/auth_callback`. Uses CIMD when advertised; DCR otherwise |
| Claude Team / Enterprise | An owner adds it once in organization settings → Connectors; each member then clicks Connect and signs in with their own Recordful account | Tokens are per member, so routing stays per user. Optional later: a Recordful workspace policy to disallow cloud AI apps for members (decided: later) |
| Claude Desktop / mobile | The connector added on claude.ai appears automatically | |
| Claude Code | `claude mcp add --transport http recordful https://mcp.recordful.app/mcp`, then `/mcp` to sign in. On the web: verify whether claude.ai connectors are available in the session | Loopback redirect on any port: the AS must accept `http://localhost/callback` and `http://127.0.0.1/callback` ignoring the port |
| ChatGPT | Settings → Apps & Connectors → Advanced → Developer mode on → Create → URL `https://mcp.recordful.app/mcp`, auth OAuth | Registers by DCR. Plan eligibility varies; verify at launch |
| Cursor | `~/.cursor/mcp.json` or the MCP settings: `{"recordful": {"url": "https://mcp.recordful.app/mcp"}}` → sign in | Verify background-agent support for OAuth MCP servers at launch |
| Directories (later) | Submit to Anthropic's connectors directory and OpenAI's apps directory; list on the MCP registry (`server.json` gains a `remotes` entry) | Directory review needs a public privacy policy, support contact and test account |

A setup page at recordful.app/docs/ai covers local and hosted side by side, with copy-paste URLs.

### Launch sequence

Staging end to end (staging Worker, preview recordful.app with its own keys, dev extension) → production behind an allowlist of user ids in the DO (`CLOUD_DISABLED` with a waitlist hint for others) → extension store release with the setting → open to everyone → directory submissions.

## Phased plan

Each phase ends in something releasable and testable on its own.

| Phase | Repo(s) | Work | Done when |
| --- | --- | --- | --- |
| **0. Decisions + spikes** (1–2 days) | all | Answer the open questions. Spike: better-auth `@better-auth/mcp` + `@better-auth/cimd` + `jwt` against 1.7.7 (or whether 1.8 is needed), issuer path, consent page hook. Spike: a 50-line Worker + DO with hibernation and auto-response ping held by the real extension for an hour | Written answers; both spikes work or a fallback is chosen. **Done: spikes 2026-10-21 ([hosted-phase-0-findings.md](hosted-phase-0-findings.md)), decisions 2026-10-22 (below)** |
| **1. Core refactor** | recordful-mcp | `src/core` + `RecorderTransport` + `ServerCopy`; `LocalTransport`; no `node:*` in core; `FakeTransport` tests | `npm run check` passes unchanged; live spike unchanged; released as a patch version |
| **2. Authorization server** | recordful-ee | `jwt` + `mcp` (+ `cimd`, DCR) plugins, migrations, discovery routes, `/oauth/consent`, `/api/agent/relay-token`, internal audit + revoke plumbing, rate limits | MCP Inspector completes OAuth against a stub resource on staging; tokens verify against JWKS; e2e test for consent |
| **3. Hosted server** | recordful-mcp `hosted/` | Worker: `/mcp`, PRM, JWT verification, `RelayTransport`, `UserRelay` DO (hibernation, auto-response ping, supersede, idle close, revocation list, rate limits, audit batching), `/internal/*`; SDK v2 move if confirmed; staging deploy at `mcp-staging.recordful.app` | A scripted fake extension (Node `ws` client speaking the relay handshake) + MCP Inspector run every tool on staging; unit tests for routing, auth failures, limits, revoke; the Phase 0 hour-long Chrome hold (`hosted/spikes/phase-0/relay/compare`) passes against staging with no unexplained drops |
| **4. Extension** | recordful | `dispatcher`/`localConnection`/`remoteConnection` split; Allow cloud AI apps + sign-in row; per-app approval window; remote arming rule; idle close; badge title; Stop agent; privacy/CWS text | Local behaviour unchanged (existing live spike); claude.ai on staging records a walkthrough end to end with the dev build |
| **5. Account page** | recordful-ee | Settings → AI apps: connected apps (name, granted, last used, Revoke), browsers connected now, activity (audit log), turn off for my account | Revoking an app stops its next call within seconds; e2e tests |
| **6. Launch** | all | Production DNS/TLS, allowlisted beta, docs page, `server.json` remotes, store release, then GA and directory submissions | claude.ai, ChatGPT, Claude Code and Cursor each record a demo against production |

Phases 1 and 2 can run in parallel. 3 needs 1 and 2; 4 needs 3 on staging; 5 can start after 2.

## Decisions (2026-10-22)

1. **DNS**: the recordful.app zone is on Cloudflare; the site stays on Vercel. `mcp.recordful.app` and `mcp-staging.recordful.app` become Workers Custom Domains. No nameserver move.
2. **Hosting**: Cloudflare Workers + Durable Objects, starting on the **Workers Free plan**. It now includes SQLite-backed Durable Objects (the kind the Phase 0 spike uses), with 100k Durable Object requests a day and a daily duration allowance; going over fails calls rather than billing. Upgrade to Paid ($5/month) when usage needs it: a plan switch, no code change. Free-plan constraint for Phase 3: **10 ms CPU per request**, so build the `McpServer` once per isolate (not per request) and measure CPU per tool call on staging.
3. **Plan**: free for every signed-in Recordful account, like local. Rate limits apply.
4. **Per-browser approval**: keep the one-time "Allow this app in this browser" window.
5. **Scopes**: one scope, `recording:control`, for recorder and page tools.
6. **Teams**: no workspace-wide switch at launch; add it when a team asks.
7. **Repo**: `hosted/` in the public recordful-mcp repo, next to the shared core.
8. **Retention and limits**: not answered; starting with the proposals above (90-day audit log, 20-minute idle close, 30-day sliding refresh tokens, the rate limits in Security). Easy to change later.
9. **Local and cloud at once**: allowed, with shared queues; the badge names whoever acted last.
