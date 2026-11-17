---
name: make-short
description: Turn a Recordful video into a vertical short (9:16, captions) for TikTok, YouTube Shorts, Reels or LinkedIn by finding its best moment and cutting to it. Use when the user asks for a short, a clip, a reel, a teaser or a vertical version of a video on recordful.app.
---

# Make a short from a Recordful video

These tools are on Recordful's hosted connector (https://recordful.app/mcp) and need Recordful Pro, write access and a transcript (if `get_transcript` says `status: "none"`, ask the user to transcribe it on its page on recordful.app).

## 1. Copy, don't overwrite

`duplicate_video` and work on the copy, so the full video stays as it is. It plays from the same files and takes no more storage.

## 2. Pick the moment

Read `get_transcript` (`format: "vtt"` for times) and `get_summary` if it already has one (generating one spends AI credits, so ask first). Pick one moment of 15 to 60 seconds that stands on its own: a clear hook in the first 3 seconds, one idea, a visible result. Check it with `get_storyboard` over that `start`/`end`. Tell the user the moment and its first line, and wait for their yes.

## 3. Cut to it

`get_timeline` for the `version` and length, then one `apply_video_edits` on the copy with `expectedVersion` and, in this order:

1. `cut_range` with `ranges`: everything after the moment, then everything before it (times as the video plays now, before any of them is cut).
2. `set_aspect_ratio` with `ratio: "9:16"`.
3. `add_captions`, then `set_caption_style` (for example `size: 56`, `plate: true`, `animation: "pop"`); captions matter most in a short, as most people watch muted.

Add `add_zoom` on the key action if the screen is too small to read at 9:16 (`follow: true` keeps the pointer in view), and `remove_fillers` to tighten it.

## 4. Check and hand over

`get_storyboard` on the copy: the action must stay in frame at 9:16. Then give the user `get_live_preview_link`, and offer to retitle the copy with `update_video` (for example "<title> - short"). The user downloads it from the editor's export.

## Rules

- Never cut the original: always the copy.
- One moment per short; offer a second short rather than stitching two.
