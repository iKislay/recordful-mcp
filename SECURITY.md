# Security model

The bridge lets a local process start screen and tab recordings. The design assumes that any process or web page on the machine may try to abuse it.

## Threats and mitigations

| Threat | Mitigation |
| --- | --- |
| A remote machine connects | The bridge binds `127.0.0.1` only, and this isn't configurable |
| A web page (including via DNS rebinding) connects to the port | Browsers always send `Origin` on WebSocket upgrades, and the upgrade is refused unless it's `chrome-extension://<id>` |
| Another extension connects | Optional ID allowlist (`RECORDFUL_BRIDGE_ALLOWED_EXTENSION_IDS`), plus it would need the token |
| A local process pretends to be the extension | HMAC challenge-response over the pairing token |
| **A rogue local process grabs the port first and tells the extension to record** | The extension verifies the server's proof and refuses all requests until it passes. The token never goes over the wire, so a rogue server learns nothing from the handshake |
| Replaying a captured handshake | Fresh 32-byte nonces from both sides on every connection; proofs are bound to role and to both nonces |
| Token leakage through logs | Logs go to stderr only, and fields named `token`, `proof`, `secret` or `authorization` are redacted |
| A token file readable by other users | Created with mode `0600` in a `0700` directory on POSIX; on Windows it inherits the user-profile ACL |
| Memory exhaustion | 1 MiB frame limit, a 5 s handshake deadline, a single active session, and heartbeat eviction |
| Bridge code shipping to store users | It's compiled in only for development builds. Webpack refuses the flag otherwise, and the existing release gate flags loopback URLs |

## Out of scope (Phase 0)

- Malware running as the same OS user. It can read the token file, and it could already capture the screen itself.
- A user-facing consent UI ("Claude is controlling Recordful"). Planned for Phase 1, together with the in-extension pairing flow that replaces baked-in tokens.

## Rotating the token

```bash
node dist/cli.js token --rotate
```

Then update the extension: rebuild with the new `RECORDFUL_AGENT_BRIDGE_TOKEN`, or set `chrome.storage.local.agentBridgeToken`. The extension reconnects automatically when that storage key changes.

## Reporting

Report vulnerabilities privately to the maintainers. Please don't open a public issue.
