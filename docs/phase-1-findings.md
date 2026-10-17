# Phase 1 findings: page tools

**Question:** can an agent with no browser tool of its own walk through a feature in the tab Recordful records, using only `recordful-mcp`?

**Answer:** yes, in the tab the user handed over by clicking the Recordful icon. Recordful navigates, lists the page's interactive elements, clicks, types, presses keys, scrolls, waits and takes screenshots there, with a rendered cursor so the video looks like a person using the app. Synthetic input has limits (below).

Tested 2026-10-17 with `scripts/live-spike.mjs --pages` in Microsoft Edge 155 (Chromium 155), a fresh profile, a local test page, and Recordful 4.6.15 `build:agent`.

## Verified live

| Check | Result |
| --- | --- |
| Any page tool before a tab is handed over | ✅ `NOT_ARMED`, with a hint to ask for the click |
| `navigate` to the test page | ✅ Loaded in about 400 ms; final URL and title reported |
| `snapshot` | ✅ Heading, button, text field, submit button, link (marked offscreen) and a checkbox hidden behind its styled label, each with a ref, role, name, state and box. Recordful's own UI isn't listed |
| `click` a button | ✅ The cursor glided to it and the ripple showed; the page saw the click at the cursor's point |
| `click` the hidden checkbox's label | ✅ The checkbox toggled |
| `type` into the field | ✅ "hello world" at a human pace; the field held it |
| `scroll` down, then to a ref | ✅ Smooth, settled before returning |
| `screenshot` | ✅ JPEG downscaled to 1280 px wide, about 30 KB |
| Another tab in front | ✅ `snapshot` still acted on the handed-over tab; `screenshot` refused with `TAB_NOT_ACTIVE` |
| `press` Enter in the field | ✅ Submitted the form; the navigation was reported |
| `wait_for` text after the navigation | ✅ |
| A ref from before the navigation | ✅ `STALE_REF` |
| During a live tab recording | ✅ In one run the recording went live on the handed-over tab, and clicking, typing, scrolling, screenshots, pause/resume and Enter submitting the form all worked during it |
| Release build | ✅ None of it: a search of `build/`, source maps included, for every bridge and page-tool identifier found nothing |

The automated run stands in for two things a person does once: `--allowlisted-extension-id` replaces the click on the Recordful icon, and a copy of the build declares its optional permissions as required, replacing the one-time permission prompt.

## Found along the way

- **Recordful's own prompts block an agent's start.** Camera and microphone access prompts, and Recordful's "Your microphone is muted… continue without audio?" dialog, wait for a person. Page tools deliberately can't click Recordful's UI, so `start_recording`'s "pending" hint now mentions them.
- **Modal dialogs mark the whole page `aria-hidden`**, Recordful's popup included. Visibility checks ignore `aria-hidden`; otherwise every element looked hidden while the popup was open.
- **Automated starts are unreliable in a fresh Edge profile.** Capture fails with `NotFoundError: Requested device not found`, then `AbortError: Error starting tab capture` (`REC_START_STREAM`, `REC_START_TAB`), with the microphone on, off or faked. This is in the recorder's start path, not the page tools, and the Phase 0 hands-on runs in Chrome didn't hit it.
- **`start_recording` can report `START_FAILED` and still go live** about 5 s later: the grace period after the pending flag clears is too short for some start paths.

## Limits of synthetic input

Pages receive `isTrusted: false` events. Links, buttons, checkboxes, labels, text fields and form submits work. Native `<select>` popups (`type` picks the option instead), file pickers, anything gated on a real user gesture (pop-ups, clipboard, fullscreen), CSS `:hover`, and content inside iframes don't. `press` performs keys' default effects itself, since synthetic key events have none.

## Still open

1. The whole flow through an MCP client against the user's own Chrome, hands-on: click the icon, then let the agent navigate, start, act and stop.
2. Fail-fast starts that name the prompt that is waiting (roadmap).
3. The "Agent is controlling Recordful" badge with a stop button, markers, and pairing from the extension's UI (roadmap).
