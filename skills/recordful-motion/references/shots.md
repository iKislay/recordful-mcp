# Shots

Each shot: when to use it, how it is built (numbers are starting points measured from professional films, not laws), and the HyperFrames registry block to start from (`npx hyperframes add <name>`; `(c)` is a component you merge into a scene). Eases are GSAP names.

## Timing that applies to every shot

- **Ease by role**: an arrival lands on a long tail (`expo.out`, `power4.out`); a camera move or colour change eases both ways (`power2.inOut`); a zoom-through or an exit accelerates (`power3.in`). One `power2.out` at 0.5 s on everything is the single biggest tell of generated motion. Linear only for rotation, progress and constant speed.
- **Arrive slow, leave clean**: exits are 40-50% shorter than entrances, one smooth move (never slide, stop, then leave).
- **Overlap**: the next element starts when the previous is 30-50% done. Fully sequential looks robotic; all at once looks cheap.
- **Stagger**: letters 20-40 ms apart, words 60-120 ms, lines 60-100 ms, list items 40-80 ms.
- **Fast moves** take 0.3-0.6 s and carry motion blur at their fastest frame: 6-12 px on text, 15-20 px full-frame (`data-motion-blur="on"` on the root).
- **Springs** by damping: 1.0 never bounces, 0.7-0.85 reads premium, 0.4-0.6 playful. Position and scale may bounce; opacity and colour never do.

## Text in

Vary the entrance within one video: never the same one for every line.

| Shot | Use it for | Build | Start from |
| --- | --- | --- | --- |
| Word blur-in | a statement, a title | per word `blur(6px)`→0 and opacity 0→1 in 0.13 s, words 0.067 s apart, no movement | `blur-in` (c), `soft-blur-in` (c) |
| Line blur-in | a short title | the whole line 8 px→0 blur in 0.13-0.2 s | `blur-in` (c) |
| Ink-in | a calm sentence | per word from light grey to ink, 0.07-0.1 s apart, no movement | `per-word-crossfade` (c) |
| Mask rise | a headline with weight | each line rises from behind a mask: `translateY(110%)`→0 in 0.6 s `expo.out`, lines 0.08 s apart | `per-word-rise` (c), `lt-mask-reveal` |
| Name by letter | a person's or product's name | per letter opacity 0.3→1 with a slight blur, 0.1 s apart | `bottom-up-letters` (c) |
| Slot roll | one word that changes ("faster / safer / cheaper") | that word rolls through options like a slot machine, about 0.1 s a roll, then lands | `slot-machine-roll` (c), `kinetic-type-swap` (c) |
| Clip wipe | a label, a tag | `clip-path: inset(0 100% 0 0)`→`inset(0)` in 0.6 s `expo.out` | `lt-clean-bar` |

**Holds**: a read line holds 0.5 s + 0.3 s a word; the video's last line at least 2 s. A landed title is dead still: the motion moves to the next element. **Out**: blur-out and fade in 0.13-0.25 s, word by word or with the scene's move.

**Size**: titles at 4-9% of the frame height, one or two lines; one highlighted word in the accent colour, and only when the word carries the meaning.

## Over the recording

| Shot | Use it for | Build | Start from |
| --- | --- | --- | --- |
| Lower third | naming who speaks or what is shown | the bottom 30% of the frame, left-aligned in the safe area; in over 0.4 s `power2.out`, out over 0.35 s `power2.in`; holds while it is relevant, gone in 8 s | `lt-clean-bar`, `lt-dark-card`, `lt-soft-pill`, `lt-kicker-name` |
| Callout | pointing at one control in the UI | an arrow or circle drawn on (stroke 0→full in 0.4 s), the label lands 0.1-0.2 s after; placed by the control, not centred | `hw-arrow` (c), `hw-callout-circle` (c), `hw-box-label` (c) |
| Highlight a word | the word that matters in a sentence on screen | a marker sweeps under it in 0.3-0.5 s after the sentence lands | `marker-highlight` (c), `hw-underline` (c), `mk-callout-highlight` |
| Number callout | a number said out loud ("73% fail") | the number counts up over 0.8-1.2 s `power2.out` and lands big (8-15% of the frame height), its label 0.15 s after; on screen within 2.5 s, then held | `count-up` (c), `number-pop-in` (c), `mk-progress-stat` |
| Click accent | a click that changes the screen | none by default: the recording's own click effect does this. Click rings are a generated-motion tell | — |

## Full frame

| Shot | Use it for | Build | Start from |
| --- | --- | --- | --- |
| Chapter card | a new part of the video | one or two words at 4-9% height, in and held 0.4-1 s, out with the next shot's move; never a slide with a heading and bullets | `hw-title`, `yt-prism-title` |
| Title card | the opening | the title arrives with a word or mask entrance, holds dead still, leaves into the recording | `canopy-part-title`, `yt-prism-title` |
| End card | the close | the mark lands in the last 5-10%, centred, 15-30% of the frame's width, performed (a fill rises through it, a wipe brings the wordmark), then the call to action held 1.5-3 s | `logo-outro`, `logo-brand-close` (c) |

## Transitions with a cause

Use 3-5 kinds in one video, each caused by something on screen; at most a third of the seams are hard cuts, and two worlds never crossfade.

| Transition | Build | Start from |
| --- | --- | --- |
| Zoom through a button | the camera tracks to the button with blur (0.6 s), then the button scales from about 8% to 250% of the frame in 0.35 s, strong ease-in; its fill becomes the next frame | `zoom-through-transition` (c) |
| Object becomes the world | a card grows past the frame in 0.65 s ease-in-out, its radius shrinking; around it blurs about 15 px and fades in 0.3 s; the new content fades in while it still grows | `transitions-scale` |
| Morph | one container widens into the next (110 to 880 px in 0.2 s `power3.out`) with a horizontal blur 12→0 | `transitions-scale` |
| Whip | a horizontal or vertical smear of 0.13-0.3 s; the arriving element lands blurred and sharpens in about 0.13 s | `whip-pan`, `whip-pan-cut` (c) |
| Iris from the click | `clip-path: circle()` opens from the clicked point onto the next view in 0.15 s | `iris-reveal` (c) |
| Colour flood | the hero stays while the whole ground changes colour in about 0.4 s `power2.inOut` | `transitions-radial` |
| Dip cut | the outgoing frame darkens about 40% for 3 frames before a hard cut, so the cut reads as meant | — |

## Punch-ins on the recording

Recordful's own zooms do this on the video itself (Zoom tool, or zooms from clicks). A motion layer never re-implements them; when a shot needs the camera to close in, say so to the person and leave it to the editor's zoom.
