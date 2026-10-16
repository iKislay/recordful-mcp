# Phase 0 findings

**Question:** can an AI agent start and stop a Recordful recording on its own, with no user click?

**Answer:** it can control the recorder, but **Chrome will not let it start tab capture until a human has invoked Recordful on that tab.** One click on the Recordful icon is enough. After that, the agent started, paused, resumed and stopped the recording itself, and the editor opened automatically.

Tested 2026-10-17 in two ways:

- **Automated:** `scripts/live-spike.mjs` in Microsoft Edge 155 (Chromium 155), with a fresh profile on https://example.com.
- **Hands-on:** the user's own Google Chrome, with the bridge driving and the user providing the click.

Both used Recordful 4.6.14 `build:agent`.

## Hands-on results (user's Chrome)

| Step | Who | Result |
| --- | --- | --- |
| Load `build/` unpacked | user | Connected to the bridge within seconds; handshake passed |
| One manual recording | user | Granted `desktopCapture`, `offscreen`, `alarms` (one time only) |
| `recording.pause` on that live recording | bridge | ✅ `paused` in 257 ms; `status.get` confirmed |
| `recording.resume` | bridge | ✅ `recording` in 260 ms |
| `recording.stop` | bridge | ✅ Stopped in 1.4 s; the editor opened on its own (`editor.html?mode=postStop&recordingId=…`) |
| User clicks the Recordful icon, without pressing Start | user | Grants activeTab |
| `recording.start` | bridge | ✅ `recording` after 9.9 s (countdown and setup), "Tab area" mode |
| `recording.stop` | bridge | ✅ Stopped in 3.1 s; the editor opened on its own |

Editor note: in these runs the test build was made with `RECORDFUL_EDITOR=builtin`, so stop opened the built-in editor. Every build now hands off to the web editor (`/editor?ext=<extension id>`), with the built-in editor kept only as the offline and recovery fallback. Re-tested in the user's Chrome against a local recordful-ee: the recording opened in the web editor and no extension errors were logged.

Mode note: the popup's "Tab area" is stored as `recordingType: "region"`. That's the mode verified here. Plain `tab` was only exercised in the automated run, where it stalled without a gesture as expected.

## Verified live

| Check | Result |
| --- | --- |
| Extension dials out to the bridge on load | ✅ Connected about 1 s after the service worker started |
| Mutual HMAC handshake | ✅ Session established, server proof accepted by the extension |
| `status.get` | ✅ Real state, mode (`tab`), active tab and permissions |
| `capture.probe`: tab capture with no gesture | ❌ `chrome.tabCapture.getMediaStreamId` fails with *"Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured."* |
| `recording.start` with no gesture | ⚠️ Reaches Recordful's normal start flow (popup opens, "Starting recording…"), then stalls. Returns `outcome:"pending"` with a hint telling the agent to ask for the gesture |
| Key press sent by Playwright (CDP), `Alt+Shift+G` | ❌ Doesn't reach `chrome.commands`; extension shortcuts need real OS input |
| Production build | ✅ Contains no adapter code; webpack refuses `RECORDFUL_AGENT_BRIDGE=1` outside development |

Unit and integration suite: 34 tests covering the handshake and security rejections, the request lifecycle, timeouts, disconnects, superseding, heartbeat, the MCP tools and config/token handling.

## Still open

1. Whether the activeTab grant survives the agent navigating the tab (same-origin vs. cross-origin), and how long it lasts. In the hands-on test, the start came about 10 s after the click with no navigation in between.
2. `screen` mode end to end. It always shows Chrome's picker, so the agent can start it but a human has to pick the source.
3. The full loop through an MCP client (Claude Code calling the tools) rather than direct bridge calls. The MCP layer is covered by the in-memory tests, but it hasn't been run against the live extension.

To re-run the hands-on check: load `recordful/build` unpacked, run `node dist/cli.js call status.get`, click the Recordful icon on a normal page, then run `node dist/cli.js call recording.start`, followed by `recording.pause`, `recording.resume` and `recording.stop`.

## What this means per recording mode

| Mode | What has to happen before capture | Fully unattended? |
| --- | --- | --- |
| Tab (`tab`) | User invokes Recordful on the tab (toolbar icon or shortcut), which grants activeTab | No: one click per tab |
| Screen (`screen`) | Chrome's screen picker; a human chooses | No |
| Region (`region`) | `getDisplayMedia` from the page needs user activation plus the picker | No |
| Any mode, fresh profile | One-time grant of optional permissions (`desktopCapture`, `offscreen`, `alarms`) | One time only; existing Recordful users have usually granted them already |

## Product notes found along the way

- **A start without a gesture hangs instead of failing.** The popup stays on "Starting recording…" and `pendingRecording` stays `true` until Recordful's own watchdogs clear it. A human never hits this path, but an agent does. The extension should fail fast with a clear error when tab capture is refused.
- **Probing has a cost.** An unconsumed tab-capture stream ID can hold the tab briefly, so `capture.probe` shouldn't be called right before a real start. The spike waits 8 s between them.

## Recommended Phase 1 direction

1. **"Arm" flow (the main path, verified working in Phase 0).** The user clicks the Recordful icon on the tab, or presses the shortcut, to hand that tab to the agent. The extension remembers the armed tab, and `start_recording` targets it. The agent can then plan, navigate within the app and start whenever it's ready. This is one click, and it doubles as clear consent.
2. Have `start_recording` return `needs_user_gesture` straight away instead of stalling: track activeTab grants in the extension (from `action.onClicked` / `commands.onCommand`) rather than probing.
3. Show a visible "Agent is controlling Recordful" badge while a session is connected, plus pairing from the extension UI to replace baked-in tokens.
4. **Unattended runs in a dedicated profile.** Investigate Chromium testing switches such as `--auto-select-desktop-capture-source` / `--auto-select-tab-capture-source-by-title` for CI-style demo generation. These are flags you'd launch the browser with, not something a normal user's Chrome would have.
5. **Markers.** Add an `add_marker` tool and timeline events so Phase 2 editing (cutting dead air, zooming at markers) has structure to work with.
