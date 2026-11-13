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

Done in recordful-mcp 1.2.0 with extension 4.8.0 (proved end to end in real Chrome, 21 of 21):
- `get_transcript` with `query`; `get_summary` (AI summary and chapters, also a Summary tab on the view page).
- `get_analytics`, and `viewsBy` plus views per day on `get_video_activity`.
- `list_trash`, `restore_video`, `delete_video` with `dryRun`.
- `update_video` with `password` and `expiresAt`; `delete_comment`; `list_members`, `invite_member`.

Still missing, biggest first:

| Gap | Cap | What it takes here |
| --- | --- | --- |
| Library tools without Chrome | `CAP_API_KEY` / desktop login; CI can upload, transcribe, comment, manage the library | Every cloud tool goes through the extension. Needs a CLI sign-in (PKCE loopback like `lib/desktop-auth.ts`) and an HTTP `RecorderTransport` for the `video.*`, `folder.*`, `trash.*`, `members.*` and `analytics.*` methods. API routes already accept a bearer session |
| Summary in the desktop app | n/a | The desktop cloud view (`RevampCloud.tsx`, `parseCloudView`) shows Transcript and Comments; add the Summary tab from `/api/videos/:id/summary` |
| Duplicate, download | `caps_duplicate`, `caps download` | No routes. Download could hand out the export page link |
| Edit a transcript | `caps_transcript_replace` with a revision check | Captions are edited in the web editor only |
| Comment replies, reactions | `caps_reply`, `caps_react` | `recording_comments` has no parent id |
| Members: roles, removal | role, seat, remove | Invite and list only |
| Loom import | `caps_import_loom`, per-row for migrations | Not started |
| Recording cards in chat | MCP Apps resource `ui://cap/recording-card.html` | Text results only |
| Headless validate/export | `cap project validate`, `cap export` | Extension recordings export in the editor only |

## Against Tella and Screen Studio (researched 2026-11-14)

**Tella** (tella.com/docs/mcp-server, tella.com/mcp): a hosted MCP at `api.tella.com/mcp`, OAuth or a personal API key, 98 to 100+ tools on every plan, plus an in-product agent. External agents can *edit*: `apply_video_edits` (up to 200 timeline edits per call), clips, layouts, crops, zooms (including "wherever I clicked"), blurs and highlights, text and shape overlays, chapters, music, sound effects, Studio Sound, Tella Motion. They can *look*: `get_storyboard`, `get_video_frame`, `get_video_preview`, `get_clip_frame`. They can *publish*: export, share links, YouTube, LinkedIn, X, Instagram, Facebook, embeds, playlists, tags, webhooks, analytics, account and agent credits, `create_checkout_link`. Auto Capture records a web page with an animated cursor and returns the take with chapters and suggested cuts. Skills come as an official `tella` skill, community skills (`search_community_skills`) and `skill://` resources. The reliability contract: `outputSchema` plus `structuredContent`, error codes with `retryable`, `_meta.idempotencyKey` replay for 24 h, `baseRevision` plus `edit_conflict`, and `dryRun`.

**Screen Studio**: no official agent surface (no MCP, CLI or documented API; three undocumented deeplinks; its "agent-friendly" feature request has no team reply). Community bridges show what agents want from it. screenstudio-cli drives the Electron app over CDP: record a window or display, slice, zoom, mask, config, preview and render frames, undo. screenstudio-mcp has 46 tools: record while operating apps, 20 edit operations, 111 settings, on-device OCR auto-blur of emails, keys and card numbers, TTS narration, music ducking, one edit exported to X, LinkedIn, Shorts, docs and GIF, presets and brand kits.

Where Recordful's agent surface lags, and whether we can build it without hosting an MCP (all through recordful-mcp + the extension, or the desktop app):

| # | Gap | Who has it | Build? | How |
| --- | --- | --- | --- | --- |
| 1 | External agents edit the video (cut, zoom, frame, captions, chapters, blur), batched, with dryRun and a revision check | Tella, Screen Studio community | **Yes** | The in-editor agent's edit operations are pure functions (`lib/agent-tools.ts`). Add `POST /api/videos/:id/edits` that applies a batch to `recordings.edits` with `baseRevision` (`updatedAt`) and `dryRun`, then `video.edit` and an `edit_video` tool |
| 2 | Look at the video: a frame at a time, a storyboard of frames | Tella, Screen Studio community | **Yes** | The extension seeks the video in an offscreen document and returns a small JPEG, or a contact sheet. Needs the R2 bucket's CORS to allow the extension origin, or a same-origin proxy |
| 3 | Remove fillers and silences, zoom where clicked, from outside the editor | Tella | **Yes** | Needs word timings kept with the transcript (Deepgram already returns them; only text and VTT are stored) and the scene's clicks (`scenes.data`) on the server |
| 4 | Account and credits for agents, an upgrade or top-up link | Tella | **Yes, small** | `account.get` adds AI credits left and renewal (`/api/agent/credits`); a link to recordful.app/upgrade. Top-ups need a Polar product |
| 5 | Structured results and safe retries (`structuredContent`, `retryable`, idempotency keys) | Tella | **Yes, small** | Bridge-side: return `structuredContent`, mark codes retryable, replay by key |
| 6 | API key for headless or CI use, no Chrome | Tella, Cap | **Yes** | API keys in recordful-ee and an HTTP transport in recordful-mcp (row 1 of the Cap table) |
| 7 | Auto Capture returns chapters and suggested cuts | Tella | **Yes, small** | We already film pages with page tools. On `stop_recording`, return markers as chapters; after upload, `get_summary` gives chapters |
| 8 | Webhooks: video ready, transcript ready, comment | Tella | **Yes** | A `webhooks` table, signed POSTs from the upload, transcript and comment routes, and agent tools to manage them |
| 9 | More skills: edit, clean up, publish, plus a community list | Tella, Screen Studio community | **Yes** | More `SKILL.md` files in recordful-mcp. A community directory needs a site page and review (AI-AGENT-TODO Phase C) |
| 10 | Tags or playlists | Tella | **Yes** | We have folders. Tags need a table; playlists only if the user wants them |
| 11 | Privacy auto-blur (emails, keys, card numbers) | Screen Studio community | **Yes, mid** | The edit has blur. Detection needs OCR on frames (Tesseract.js in the extension's offscreen document, or the desktop app's native OCR) |
| 12 | One edit exported to several formats (X, LinkedIn, Shorts, GIF) | Screen Studio community | **Yes, mid** | Export presets over the existing export: ratio, padding and caption size per target |
| 13 | Record through the desktop app (windows, displays) | Screen Studio community | **Yes** | AI-AGENT-TODO D-b: the desktop app as a bridge client. Screenshots already work this way |
| 14 | Motion graphics, sound effects, music | Tella, Screen Studio community | **Partly** | Motion is AI-AGENT-TODO Phase B (HyperFrames). Sound effects and music need a licensed library |
| 15 | Publish to YouTube, LinkedIn, X, Instagram, Facebook | Tella | **Not soon** | Each needs its own developer app, OAuth and platform review; Meta and YouTube reviews take weeks. Ship share links and embeds first |
| 16 | Hosted MCP for chat apps (Claude.ai, ChatGPT) | Tella, Cap | **Not now** | User decision 2026-11-14: no hosted MCP for now |

Recordful is ahead on: driving the user's own browser with a visible cursor while it records (Tella's Auto Capture uses its own browser and doesn't reach signed-in pages without a saved login), desktop screenshots by an agent, and confirm-before-change on every publishing or destructive tool.

Suggested order: 1 and 2 together (edit and look is the loop agents need), then 4, 5 and 7 (small), then 3, then 6, 8, 13.
