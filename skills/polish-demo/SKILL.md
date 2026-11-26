---
name: polish-demo
description: Polish a Recordful screen recording into a finished product demo - zooms on the clicks, a background and frame, click effects, a cleaner voice, captions and chapters. Use when the user asks to polish, finish, make professional or "make it look good" a demo or walkthrough video on recordful.app.
---

# Polish a demo on Recordful

These tools are on Recordful's hosted connector (https://recordful.app/mcp) and need Recordful Pro and write access. Captions and chapters also need a transcript (start one with `transcribe_video` if `get_transcript` says `status: "none"`).

## 1. See what it has

`get_timeline` (zooms, frame, background, captions, audio and its `version`), `get_storyboard` to see the screens, and `get_audio` for the voice settings. Keep what the user already set; polish only what is missing.

## 2. Propose one pass

Tell the user, in a few lines, what you will do from this list, and wait for their yes:

- **Zooms**: `generate_auto_zooms` makes one on each burst of clicks (fails if no clicks were recorded; then place `add_zoom` by hand on the key moments from the storyboard).
- **Look**: `list_backgrounds`, then `set_background` (a gradient or image that suits the product's colours) and `set_frame` (for example `padding: 60`, `radius: 16`, `shadow: 40`).
- **Clicks**: `set_cursor_effects` (for example `effect: "ripple"`; a `sound` only if the user wants one).
- **Voice**: `set_voice_enhancement` with `noiseAndEcho: true`, `mouthSounds: true`, `breaths: true`.
- **Captions**: `add_captions`, then `set_caption_style`.
- **Chapters**: for videos over about 2 minutes, `get_chapters` (or the AI ones in `get_summary`, which spends credits if none exists yet: ask first), then `set_chapters` with a title at each new part.
- **Tighten** (optional): `remove_fillers` and `remove_silences`; for real mistakes use the remove-mistakes skill.

## 3. Apply

Run the edit operations in one `apply_video_edits` with `expectedVersion` from `get_timeline`: `generate_auto_zooms`, `set_background`, `set_frame`, `set_cursor_effects`, `set_voice_enhancement`, `add_captions`, `set_caption_style` (and `remove_fillers` / `remove_silences` last, as cuts move later times). Then `set_chapters` on its own. On `edit_conflict`, read again and retry.

## 4. Check

`get_storyboard` and `get_video_frame` on a zoomed moment, then give the user `get_live_preview_link` and a line per change. The voice clean-up is processed in the browser as the video plays and in its export, so it doesn't show in frames.

## Rules

- Never overwrite a look or captions the user set without asking.
- Pick colours from the product being shown, not your defaults.

Tool reference: [zooms](https://help.recordful.app/docs/ai-agents/tools/zooms), [look](https://help.recordful.app/docs/ai-agents/tools/look), [audio](https://help.recordful.app/docs/ai-agents/tools/audio), [captions](https://help.recordful.app/docs/ai-agents/tools/captions).
