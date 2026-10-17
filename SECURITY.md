# Security model

recordful-mcp lets a local program start screen and tab recordings and click and type in a browser tab. The design assumes that any process, web page or other extension on the machine may try to abuse it.

## Threats and mitigations

| Threat | Mitigation |
| --- | --- |
| Someone who never asked for AI control gets it | The extension makes no connection at all until the user turns on AI agents (Recordful popup → More → AI agents). Turning it off disconnects at once |
| A remote machine connects | The server binds `127.0.0.1` only, and this isn't configurable |
| A web page (including via DNS rebinding) connects to the port | Browsers always send `Origin` on WebSocket upgrades, and the upgrade is refused unless it's an allowed `chrome-extension://` origin |
| Another extension connects | Only the Chrome Web Store build of Recordful is allowed by default; other IDs must be added explicitly (`RECORDFUL_BRIDGE_ALLOWED_EXTENSION_IDS`) |
| An app the user didn't mean to approve gets paired | Pairing needs a click on Allow in Recordful's own window, which names the app and shows a 4-digit code; the agent shows the same code in chat, and the user is told to allow only if they match. Pairing is only ever started by a user gesture, never by an automatic reconnect |
| A local process pretends to be the extension | HMAC challenge-response over a per-pairing secret; the secret is never sent after pairing |
| **A rogue local process grabs the port first and tries to control Recordful** | The extension verifies the server's proof and refuses all requests until it passes. An unpaired rogue server can only ask to pair, which shows a window with a code that won't match the agent's |
| Replaying a captured handshake | Fresh 32-byte nonces from both sides on every connection; proofs are bound to role and both nonces |
| The agent acts outside the intended tab | Page tools act only on the tab the user handed over by clicking the Recordful icon, or the tab being recorded |
| Silent control | The Recordful icon shows an "AI" badge, and the AI agents page names the connected app, while a session is live |
| Secret leakage through logs | Logs go to stderr only, and fields named `token`, `proof`, `secret` or `authorization` are redacted |
| The pairing file readable by other users | Written with mode `0600` in a `0700` directory on POSIX, atomically (write, then rename); on Windows it inherits the user-profile ACL |
| Memory exhaustion | 1 MiB frame limit, handshake and pairing deadlines, a single session, and heartbeat eviction |
| Test shortcuts reaching users | A baked-in shared secret and port override exist for scripted tests only, and are compiled out of every non-development build |

## Out of scope

- Malware running as the same OS user. It can read the pairing file and could already capture the screen itself.
- A user who approves a pairing without checking the code.

## Revoking access

- In Chrome: Recordful popup → More → AI agents → Paired AI apps → **Forget**, or turn AI agents off.
- On the computer: `npx -y recordful-mcp unpair --all` (or `unpair <extension-id>`). Recordful asks to pair again the next time it's needed.

## Reporting

Report vulnerabilities privately through [GitHub security advisories](https://github.com/iKislay/recordful-mcp/security/advisories/new). Please don't open a public issue.
