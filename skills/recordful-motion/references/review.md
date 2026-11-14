# Review

Watch the layer as a first-time viewer, once, at full speed, probably on a phone. Snapshot each shot's start, landing and exit (`npx hyperframes snapshot --at …`) and look at every still.

## Banned by default

These are where generated motion lands when nothing was decided. Each is banned unless the brand's own material or the person's reference uses it, and then only as they use it:

- glow, bloom, neon, lens flares, glowing orbs, floating particles as decoration;
- purple or blue gradients, mesh gradients, glass cards over everything;
- everything centred; everything fading in at once; every element fading and sliding up;
- the same `power2.out` 0.5 s on every move; linear moves that are not rotation or progress;
- text that moves while it is read; titles that keep drifting, breathing or pulsing after they land;
- ALL CAPS wide bold type on every line, the same letter stagger on every title, a full stop after every two-word phrase;
- click rings and bouncing UI;
- the same transition on every seam; a wipe of a flat coloured slab at every cut;
- three cards in a row, a KPI grid, a title over a dimmed screenshot, bullet points;
- corner labels, frame borders, HUD readouts as decoration; the logo docked in a corner.

After the first look, name every default the frames show, from this list or not, add it to your BANNED line, and fix it.

## Symptoms and fixes

| You see | Change |
| --- | --- |
| It feels like slides | one statement of five words or fewer and one object per shot; enter the next shot through something on screen; cut a move mid-flight |
| It feels generated | vary the eases by role; vary the title entrances; land titles and hold them still |
| Too fast | slow every move to 0.7x of its speed, nothing else |
| Too busy | remove a third of the motion; keep the moves that lead the eye |
| The text is hard to read | cut words, never shrink type; add a dark pocket behind light text instead of a glow |
| The eye has nowhere to go | one focal point per frame; the camera or the type leads, not both |
| The ending fades out | hold the last frame at least 2 s; end on the line, not on motion |

## Notes

Write each problem as one line, `t=1.2s · where · problem → exact change`, and rank it: **P0** breaks the read (unreadable, wrong, a banned default in the hero moment), **P1** weakens it (a dead stretch, a soft landing), **P2** polish. Fix every P0 and the P1s worth their time, then snapshot only what you changed. Never score the layer out of 10: a score finds nothing to fix.
