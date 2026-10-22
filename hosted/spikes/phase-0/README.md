# Phase 0 spikes (hosted connector)

Throwaway code behind [docs/hosted-phase-0-findings.md](../../../docs/hosted-phase-0-findings.md). Not part of the build or the npm package.

- `auth/`: better-auth 1.7.12 as the MCP authorization server. `npm i`, `npm run servers` (AS :4100, stub resource :4200, CIMD host :4300), then `npm run flow` in another terminal.
- `relay/`: UserRelay Durable Object. `npm i`, `npm run dev`, then `npm test` (fake extension) or `HOLD_MIN=60 npm run hold` (Chrome + the MV3 extension in `ext/`, loaded over CDP then detached).
  `src/verify.js` (`wrangler dev --config verify.jsonc --port 8788`) checks EdDSA token verification in workerd against the `auth/` servers.

On Windows, keep `--persist-to` short: wrangler's default state path under a deep folder exceeds 260 characters and every Durable Object call fails with a bare "internal error".
- `relay/compare/`: the hour-long Chrome hold that settled it. One Chrome, two copies of the extension (one on the wrangler relay, one on `plain-relay.mjs`, a bare Node `ws` relay on :8790) plus a Node client, polled every minute. Each extension keeps its own open/close log in `chrome.storage.local`, read afterwards from an extension page. Run `node compare/plain-relay.mjs`, `npm run dev`, then `HOLD_MIN=60 node compare/hold.mjs`. Keep the machine awake: a sleep drops every socket.
