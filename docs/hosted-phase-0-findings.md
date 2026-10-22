# Hosted connector, Phase 0: spike findings (2026-10-21)

Phase 0 of [hosted-connector.md](hosted-connector.md). Two spikes, both run locally on the Windows dev machine. The code is in `hosted/spikes/phase-0/` (not wired into the build).

**Bottom line:** both halves of the design work as written. better-auth needs a patch bump (1.7.7 → 1.7.12), not 1.8. Cloudflare Durable Objects with hibernation hold the extension's socket the way the design assumes. A real MV3 service worker stayed alive for a full hour on the 20 s ping alone. Seven design details change (listed at the end); none changes the architecture. One thing is left for Phase 3: the local `wrangler dev` relay dropped the socket twice and lost one response, which has to be re-measured on deployed Cloudflare.

## Spike 1: better-auth as the MCP authorization server

Setup (`ba-spike`): better-auth 1.7.12 with `bearer()`, `jwt()`, `mcp()` (from `@better-auth/mcp`) and `cimd()` (from `@better-auth/cimd`, MCP 2026-07-28 profile, the production Node fetch transport). DCR is on, and the memory adapter is used. A separate stub resource server on another port plays the Worker's role. `flow.mjs` walks the flow the way claude.ai and ChatGPT do: 401 → protected-resource metadata → AS metadata → register → authorize → consent → token → call → refresh → revoke.

| Check | Result |
| --- | --- |
| Version | `@better-auth/mcp`, `@better-auth/cimd` and `@better-auth/oauth-provider` 1.7.12 declare a peer dependency on `better-auth ^1.7.12`. recordful-ee has **1.7.7**, so it needs a patch bump. 1.8 (beta) is **not** needed |
| Discovery | AS metadata is served at `/api/auth/.well-known/oauth-authorization-server` and at the issuer-inserted path `/.well-known/oauth-authorization-server/api/auth` (RFC 8414). `issuer` = `<origin>/api/auth`. It advertises `client_id_metadata_document_supported: true`, `none` auth, `registration_endpoint`, S256 only |
| 401 challenge | `createMcpProtectedRequestHandler` returns `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp", scope="recording:control"` |
| DCR (ChatGPT, Cursor) | Public client registered (201). Authorize → consent page → code → token, all pass |
| CIMD (Claude) | **Claude Code's real document** (`https://claude.ai/oauth/claude-code-client-metadata`), fetched with the production transport. Loopback redirects on arbitrary ports work for both `127.0.0.1:53127` and `localhost:61002` (the document declares them without ports) |
| Access token | JWT, `alg: EdDSA` (Ed25519), `typ: at+jwt`. `aud` = `[resource, …/oauth2/userinfo]`. Claims include `sub`, `client_id`/`azp`, `scope`, `sid`, `iss`, 10 min `exp` |
| Verification off-origin | `jose` + remote JWKS passes. `createMcpProtectedRequestHandler` with explicit `issuer`/`audience`/`jwksUrl` passes. A better-auth **session token is rejected** at the resource (401) |
| Refresh | Rotation works (with the 30 s reuse window that `mcp()` sets) |
| Consent memory | A second authorize from the same client skips the consent page and returns a code straight away |
| Relay token | `auth.api.signJWT({ body: { payload: { sub, sid, aud: "https://mcp.recordful.app/extension", scope: "relay:extension", exp } } })` signs with the same key and verifies against the same JWKS. **It is rejected as an MCP access token** (wrong `aud`/`iss`). `iss` defaults to the bare origin, not `/api/auth` |
| Account page list | `GET /oauth2/get-consents` returns the user's grants (client id, scopes, resources, dates) |
| **Revoke gap** | `POST /oauth2/delete-consent` deletes the consent but **leaves the refresh tokens working**: a refresh after deleting the consent still returns 200. RFC 7009 `POST /oauth2/revoke` with the refresh token does stop it (400 afterwards) |
| Grant types | The metadata advertises `client_credentials` until `grantTypes: ["authorization_code", "refresh_token"]` is set, after which it's gone |
| Schema | Eight new tables: `jwks`, `oauthClient`, `oauthResource`, `oauthClientResource`, `oauthRefreshToken`, `oauthAccessToken`, `oauthConsent`, `oauthClientAssertion` |

Not tested: claude.ai's web connector and ChatGPT's real registration (that needs a public HTTPS AS, so Phase 2 on staging). Also untested: the consent and login pages as React UI, and Postgres through the drizzle adapter.

## Spike 2: Worker + UserRelay Durable Object

Setup (`do-spike`): wrangler 4.151.3 / workerd locally. `src/index.js` is the UserRelay shape: `idFromName(user)`, Hibernation API (`acceptWebSocket`, attachments), `setWebSocketAutoResponse('{"type":"ping"}' → '{"type":"pong"}')`, heartbeat checked in an alarm from `getWebSocketAutoResponseTimestamp`, and an RPC `request()` that sends a request frame and awaits the matching response.

### Fake extension (Node `ws`, `client-test.mjs`)

| Check | Result |
| --- | --- |
| Auto-response | 12/12 pings answered. **`webSocketMessage` never ran for a ping** (handled = 0) |
| Hibernation | The object was evicted while pings kept flowing (its constructor ran again on the next RPC), so pings don't hold it in memory. That's what makes idle connections free |
| State across hibernation | The socket's attachment (`authed`, client info) survived. A request after a wake found the authenticated socket and round-tripped in 3 ms |
| Long call | A response delayed 20 s (like `start_recording`) completed in 20.0 s |
| Supersede | A second connection closed the first with `4409 superseded` |
| Heartbeat | 100 s of silence → `4410 heartbeat timeout` from the alarm |

### Real MV3 service worker in Chrome (`hold.mjs`, `ext/`)

Chrome 155 (new headless), its own throwaway profile. A minimal MV3 extension loaded via CDP `Extensions.loadUnpacked`, **then CDP disconnected** so no debugger keeps the worker alive. The worker dials the relay, sends the fixed ping every 20 s and answers requests with a per-boot id. The driver asks it for that id through the relay every 2 minutes.

| Run | Result |
| --- | --- |
| 3-minute trial | One worker boot throughout (uptime 5 s → 245 s, 12 pongs). **Control:** told to stop pinging, the worker was killed by Chrome within 30 s (socket closed `1001`). So the ping alone keeps it alive, and Chrome still enforces idle shutdown without it |
| **60-minute hold** (`relay/compare/`) | **Pass.** One Chrome, two copies of the extension: one on the wrangler relay, one on a plain Node `ws` relay with the same frames. **Both workers ran 3,600 s on a single boot, with no socket close** (from the extensions' own logs). 59 of 60 requests through the wrangler relay answered. One timed out at 5 s (at 248 s) with the socket still open and the worker still on the same boot. All 60 through the plain relay answered |
| Earlier attempts | Three earlier runs aren't counted: (1) my own edit made `wrangler dev` reload (see below). (2, 3) Single extension on the wrangler relay: the socket closed `1006` after 7 and 2 minutes. The extension's log showed **its worker still alive after the close**, so Chrome didn't stop it; the connection to the local relay dropped. (4) A 20-minute comparison ran clean for 19 minutes, then both relays' sockets dropped together when the computer went to sleep (the driver's 1-minute wait lasted 3 hours). Keep the machine awake for these runs |

What this settles: **a 20 s ping keeps an MV3 worker alive for at least an hour in Chrome 155, with no debugger attached.**

What it doesn't settle: the two `1006` drops and the one lost response all happened on the local `wrangler dev` relay. The bare Node relay had none in 80 minutes. That points at the local dev stack, not Chrome, but production Cloudflare has to be measured on staging in Phase 3. Either way the extension must reconnect on `1006` straight away, and the core should retry an idempotent request (`status.get`, `page.snapshot`) once on `TIMEOUT`.

The real Recordful extension wasn't used, because it has no remote connection yet (Phase 4). The minimal extension exercises the same Chrome mechanism: worker lifetime extended by WebSocket traffic.

### Token verification inside workerd (`src/verify.js`)

Run in workerd on a separate port: the EdDSA access token from Spike 1 verifies with `jose` + remote JWKS, and so does `createMcpProtectedRequestHandler`. A missing token gets the RFC 9728 challenge, and a tampered one fails the signature check. Bundled with `nodejs_compat`, the Worker including `@better-auth/mcp` is **391 KiB (83 KiB gzipped)**.

### Code updates drop the sockets

A reload of the Worker's code (in the first hour-long attempt, an edit next to the spike made `wrangler dev` reload) restarted the object and dropped the extension's socket. `webSocketClose` **did not run**, and the next call got `NOT_CONNECTED`. Production deploys behave the same way, so:

- The extension's remote connection must treat any unexpected close (`1001`/`1006`) as "server restarting" and retry with the same backoff as local (6 tries, ~80 s). The spike extension deliberately doesn't, so drops stay visible.
- The DO can't rely on `webSocketClose` to flush the audit batch; it flushes on its 30 s alarm instead, accepting that up to 30 s of audit rows can be lost on a deploy (or it writes each row through as it happens; see Phase 3).

That attempt was discarded and the hour rerun from scratch.

### Gotcha (Windows dev)

`wrangler dev`'s default state folder under a long project path pushes Durable Object SQLite files past Windows' 260-character path limit. Every DO call then fails with a bare "internal error; reference = …" and nothing in the logs. Fix: `--persist-to` a short path (e.g. `%TEMP%\rrs`). Also, stopping a backgrounded `wrangler dev` can leave `workerd.exe` running and still holding the port, so check `Get-NetTCPConnection -LocalPort 8787` before assuming a restart took effect.

## Changes to the design

1. **better-auth 1.7.7 → 1.7.12** in recordful-ee (Phase 2's first step), plus the eight tables above.
2. **Revoking an app = delete the consent + revoke its refresh tokens** (update `oauthRefreshToken.revoked` for that user and client, or call `/oauth2/revoke` for each), + push `revoke(sub, clientId)` to the DO. `delete-consent` alone isn't enough.
3. **`grantTypes: ["authorization_code", "refresh_token"]`** so `client_credentials` isn't offered.
4. **Discovery routes in Next.js**: better-auth's `[...all]` route only covers `/api/auth/*`, so `app/.well-known/oauth-authorization-server/api/auth/route.ts` (and the `openid-configuration` twin) must forward to the auth handler. Keep `issuer` = `https://recordful.app/api/auth`.
5. **Relay tokens set `iss` explicitly** (`https://recordful.app/api/auth`) so the Worker has one issuer to check, and the Worker checks `aud` to tell the two token kinds apart.
6. **Deploys drop extension sockets** (no `webSocketClose`): the extension reconnects at once on `1001`/`1006`, and the DO flushes audit rows on its alarm. The design's hosting table said hibernated sockets survive deploys; that was wrong and is corrected.
7. **Phase 3 exit criterion added:** repeat the hour-long hold against the staging Worker on real Cloudflare (`relay/compare/hold.mjs` pointed at `wss://mcp-staging.recordful.app`), with no unexplained drops; and the core retries an idempotent request once on `TIMEOUT`.

Also confirmed for Phase 3: the Worker can use better-auth's own `createMcpProtectedRequestHandler` (no hand-written challenge code), and `jose` handles EdDSA in workerd.
