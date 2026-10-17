# Roadmap

## Goal: any AI can record a feature

Today `recordful-mcp` gives an agent the **recorder controls**. The agent still needs its own browser tool (Claude in Chrome, Playwright MCP, computer use) to click through the feature while it records. Agents with no browser access, such as opencode, Aider, or most coding CLIs and chat apps, can start and stop a recording but can't perform the walkthrough.

The fix is to have Recordful drive the page as well. The extension already runs in the tab being recorded, with `scripting`, `tabs` and `<all_urls>`, so it can act on that page directly.

## Phase 1: self-sufficient recording (shipped in 0.2 and 0.3)

Page tools, demo-quality motion, armed-tab targeting, fail-fast starts, the "AI" badge, pairing from Recordful's UI, and shipping in the store build behind the AI agents switch are done. Still open: a stop button for the agent session on the page itself, and markers.

| Area | Work |
| --- | --- |
| Page tools | `navigate(url)`, `snapshot()` (a compact list of interactive elements with stable refs, labels, roles and boxes), `click(ref)`, `type(ref, text)`, `press(key)`, `scroll(ref or direction)`, `wait_for(text or ref)`, `screenshot()`. These run in the recorded tab through the content script. They only work while a session is armed, and only on that tab |
| Demo-quality motion | Recordful moves a rendered cursor smoothly to each target before it clicks, highlights the click, and types at a human pace. That makes better videos than an external automation tool can, because Recordful owns both the page and the footage |
| Arm flow | Clicking the Recordful icon hands the tab to the agent: it grants activeTab, connects the bridge, and shows an "Agent is controlling Recordful" badge with a stop button |
| Fail fast | `start_recording` returns `needs_user_gesture` straight away instead of stalling when the tab hasn't been armed |
| Markers | `add_marker(label)`, with page actions logged on the recording timeline automatically |
| Pairing | Pair from the extension's UI instead of a baked-in token. The bridge ships in store builds, off by default, behind an "Allow AI agents" setting |

With page tools, the whole flow (plan, navigate, click, type, pause, stop) runs through one MCP server, so any MCP client can produce a demo with nothing else installed.

## Phase 2: editing

Editor tools over the same connection: `trim`, `cut_dead_air` (using markers and the pause log), `zoom_at(marker)`, `add_caption`, `export`.

## Phase 3: hosted MCP

`mcp.recordful.app` for cloud-only AI apps; see [remote-mcp.md](remote-mcp.md).
