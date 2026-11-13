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

## Against Cap (read 2026-11-13 from github.com/CapSoftware/Cap, `apps/cli` and `apps/web/lib/mcp-server.ts`)

Cap's agent surface has three parts: the `cap` CLI, which records, exports and validates `.cap` projects on a desktop; `cap mcp serve`, a local MCP server with about 85 tools that are almost all cloud library, team, billing and developer-API operations (`caps_*`, `organization_*`, `space_*`, `developer_*`); and a hosted, read-only MCP at cap.so/api/mcp (OAuth, three tools: `caps_list`, `caps_get`, `caps_context` with a recording card UI). Every mutation needs `confirmed: true`, and destructive ones take `dry_run`. The CLI also runs headless: `CAP_API_KEY` reuses no app at all.

Done on branch `cap-parity` (not released):
- `get_transcript` takes `query` and returns only the matching moments with times (like `caps_context` with a query).
- `list_trash` and `restore_video`; `delete_video` says it goes to the 7-day trash.
- `get_video_activity` returns `viewsBy` (sources, link page vs embeds, countries).

Still missing, biggest first:

| Gap | Cap | What it takes here |
| --- | --- | --- |
| Library tools without Chrome | `CAP_API_KEY` / desktop login; CI can upload, transcribe, comment, manage the library | Every cloud tool goes through the extension today. Needs a CLI sign-in (PKCE loopback like `lib/desktop-auth.ts`, or the existing OAuth provider) and API routes that accept that token, then an HTTP `RecorderTransport` for the `video.*`, `folder.*`, `trash.*` and `storage.*` methods |
| AI summary, chapters and title | `caps_process` (ai) and `caps_context` return them; the share page shows them | Nothing in recordful-ee. An Inngest step after transcription using the OpenRouter client and credits, stored with the transcript, shown on /view |
| Teams | members, invites, roles, seats, spaces, shares | better-auth's organization plugin is installed; no agent tools or extension methods |
| Views over time | `analytics_get` with a range, per video, space or org | `recording_views` has `createdAt`; add a per-day series and a workspace total |
| Comment replies, reactions, delete | `caps_reply`, `caps_react`, comment delete | `recording_comments` has no parent id |
| Edit a transcript | `caps_transcript_replace` with a revision check | Captions are edited in the web editor only |
| Duplicate, download, password | `caps_duplicate`, `caps download`, `caps password` | No routes |
| Loom import | `caps_import_loom`, per-row for migrations | Not started |
| Dry run on destructive tools | `dry_run: true` shows what would go | `delete_video` refuses without `confirm` but doesn't preview |
| Recording cards in chat | MCP Apps resource `ui://cap/recording-card.html` | The hosted connector returns text only |
| Headless validate/export | `cap project validate`, `cap export` | Extension recordings export in the editor only |
