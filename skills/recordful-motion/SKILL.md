---
name: recordful-motion
description: Make Recordful Motion layers - titles, lower thirds, callouts, number callouts, chapter cards and end cards that play over a screen recording - as HyperFrames compositions that look directed, not generated. Use when someone asks for motion graphics, a title, a lower third, a callout or text animation on a Recordful video.
---

# Recordful Motion

A motion layer is a HyperFrames composition laid over the video in Recordful's editor (web and desktop). Recordful draws it frame by frame inside the editor, so it stays editable and needs no render step. Your job is the composition, and the bar is that it looks directed by a motion designer, not generated.

Generated motion all looks the same for three reasons: the brief was adjectives, the motion was improvised property tweens instead of planned shots, and nobody watched the render. This skill removes all three. Follow the steps in order.

## 1. Turn the ask into numbers

Before any markup, write the layer's spec in your reply (keep it short):

```text
JOB:     what the viewer must know or feel when it leaves, one line
WHEN:    the moment in the recording it serves (from the transcript or the person), and its length in seconds
FRAME:   the video's width x height (the composition's data-width/data-height match it); the safe area it sits in
LOOK:    the brand's own colours and type as hex and named faces, sizes in px at that frame; never "modern" or "clean"
SHOTS:   one line per shot from references/shots.md: its name, frames, the one hero move, what is read and for how long
BANNED:  references/review.md's defaults, plus anything this video must not look like
```

Colours and type come from, in order: the person, the product being recorded (its site or app), the video itself. Never from your defaults.

## 2. Build from a shot, not from scratch

- Every shot in `references/shots.md` names a HyperFrames registry block to start from: `npx hyperframes add <name>`, then change it to the spec. A registry block was made by a designer; your first improvisation was not.
- One hero move per shot. Secondary moves travel 50-70% as far, start 100-200 ms after it, and everything else holds still.
- The root stays transparent (a layer over a video must not hide it), and it is the video's size.
- Text that must be read is at least 2.6% of the frame's short side (28 px at 1080) and holds 0.5 s plus 0.3 s a word.

## 3. Watch it, then fix it

`npx hyperframes check --json`, then `npx hyperframes snapshot --at <times>` at each shot's start, its landing and its exit. Look at every still as a first-time viewer would, then go through `references/review.md` and fix every P0 before you hand it over. Never say it is done without having looked.

## 4. Hand it over

Recordful plays a layer without the network: everything it needs is inside the file. Use HyperFrames' bundled fonts or embed the brand's as `@font-face` data URLs, inline every image as a data URL, and keep the file under 400 KB. The person adds it in the editor's Motion panel (HyperFrames composition), where the words and numbers you put in `id`'d elements or a `CONFIG` object become fields they can edit.

## Sources

The shot recipes and review rules are drawn from HyperFrames' motion, spec and review references (HeyGen, Apache-2.0), iart.ai's kinetic-typography reveal recipes (MIT) and bang-motion's anti-slide-deck rules (MIT), measured and restated for overlays on screen recordings.
