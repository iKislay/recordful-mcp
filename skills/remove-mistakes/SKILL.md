---
name: remove-mistakes
description: Clean the mistakes out of a Recordful video - retakes, false starts, wrong words, long pauses, ums and uhs - using its transcript. Use when the user asks to remove mistakes, flubs, retakes, dead air, silences or filler words from a video on recordful.app, or to "clean it up".
---

# Remove mistakes from a Recordful video

These tools are on Recordful's hosted connector (https://recordful.app/mcp) and need Recordful Pro, write access and a transcript. If `get_transcript` says `status: "none"`, ask the user to transcribe the video on its page on recordful.app; the connector never starts one.

## 1. Read what was said

`get_transcript` with `format: "words"`: every word still heard, with its `index` and when it plays now. Indexes never change as words are cut, so you can plan every cut from this one read.

## 2. Find the mistakes

- Retakes and false starts: the same sentence said twice; keep the last, clean take.
- Wrong or abandoned sentences ("no wait", "let me redo that").
- Misheard words that only need the captions fixed, not a cut.

List each as a word range (`fromWordIndex` to `toWordIndex`, both included) with the words it removes, show the list to the user and wait for their yes.

## 3. Cut

1. `cut_clip_by_transcript` with `videoId` and `wordRanges`: the cuts fall in the quiet between words. Pass `expectedVersion` from `get_timeline` to apply only to the edit you read.
2. `remove_fillers`: cuts um, uh and a "like" set off by commas. `on: false` puts them back.
3. `get_silences` (default `minSeconds` is the editor's long pause), then `remove_silences` with `minSeconds` (and optional `keepSeconds`, how much of each pause stays). It replaces any silences it cut before.
4. If the video has captions, fix misheard words with `update_transcript_words` (`find` / `replace` pairs); the stored transcript stays as heard.

On `edit_conflict`, read again and redo the step; on `not_ready`, the transcript is missing or too old for word timings.

## 4. Check

`get_transcript` with `format: "words"` again: the cut words are gone. Spot-check the seams with `get_video_frame`, then give the user the video's `viewUrl` and a line on what was removed (how many retakes, fillers and seconds of silence).

## Rules

- Never cut meaning: when unsure whether a line is a mistake, ask.
- Show the cuts before making them. Every cut can be undone in the editor.

Tool reference: [cleanup](https://help.recordful.app/docs/ai-agents/tools/cleanup), [clips](https://help.recordful.app/docs/ai-agents/tools/clips), [captions](https://help.recordful.app/docs/ai-agents/tools/captions).
