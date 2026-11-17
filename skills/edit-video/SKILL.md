---
name: edit-video
description: Edit a Recordful video on recordful.app - cuts, zooms, captions, frame, speed - by looking at it, planning the change and applying it in one versioned call. Use when the user asks to edit, trim, tighten, fix or change a video that is already on recordful.app ("cut the first 10 seconds", "zoom in on the settings page", "make it look nicer").
---

# Edit a Recordful video

The edit tools are on Recordful's hosted connector (https://recordful.app/mcp) and need Recordful Pro and write access. Every edit is undoable in the editor; the recording's files never change.

## 1. Find the video

`search_videos` (by title or by what was said) or `list_videos`, then `get_video`. If several match, ask which one.

## 2. Look before you change

- `get_timeline`: clips, zooms, captions, frame, background, audio, and the edit's `version`. Every time is in seconds of the video as it plays now.
- `get_storyboard`: 16 frames on one sheet to see what happens when. `get_video_frame` looks closer at one moment. On `not_ready`, call again after `retryAfterSeconds`.
- `get_transcript` (with `query` on long videos) to find a moment by what was said.

## 3. Plan and show it

Write the change as a short list of operations with their times (for example: cut 0-4.5, zoom 12-18 on the Save button, captions on). Show it to the user and wait for their yes.

## 4. Apply it in one call

`apply_video_edits` with `videoId`, `operations` (each `{ type, ... }`: `cut_range`, `add_zoom`, `set_frame`, `set_background`, `set_aspect_ratio`, `add_captions`, `set_clip_speed`, and the rest its description lists) and `expectedVersion` from `get_timeline`. It is all or nothing, and the operations run in order on the edit the one before left, so after a `cut_range` later times move earlier: put cuts last, or work from the end of the video backwards.

- `invalid_argument`: nothing applied; fix the named operation and retry.
- `edit_conflict`: the video changed meanwhile (the user may be editing it). Read `get_timeline` again, re-plan, retry.

## 5. Check it

`get_storyboard` again (or `get_video_frame` at the changed moments) and the returned `timeline`. Then give the user `get_live_preview_link` or the video's `viewUrl` and say in a line what changed.

## Rules

- Show the plan before any change. Never change a video the user didn't name.
- One `apply_video_edits` per plan, not one call per operation.
- Don't retry after `PRO_REQUIRED` or `forbidden`: only the person who recorded it, or the workspace owner, can edit it.
