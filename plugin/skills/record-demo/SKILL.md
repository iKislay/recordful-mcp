---
name: record-demo
description: Record a product demo video of a feature with Recordful (Chrome). Use when the user asks to record, film or make a video or demo of a feature, flow or page ("record how sign-in works", "make a demo of the new billing page", "record the feature you just built"), including right after you built the feature.
---

# Record a product demo with Recordful

Recordful is a Chrome extension that records the browser and opens the result in its editor. The `recordful` MCP server lets you control it: recorder tools (`get_status`, `start_recording`, `pause_recording`, `resume_recording`, `stop_recording`) and page tools that act on the tab being recorded (`navigate`, `snapshot`, `click`, `type`, `press`, `scroll`, `wait_for`, `screenshot`). You don't need a browser tool of your own.

## 1. Work out what to show

Understand the feature the way a user sees it. If you or the user just built it, read the change (git diff, recent commits, routes, pages, components). List the screens and moments worth showing: the main path first, then at most one or two telling states (a validation error, an empty state). Leave out internals.

## 2. Get the app running

If it's a local project, find how to run it (package.json scripts, README, Makefile, docker compose) and the URL it serves. If it isn't running, start it in the background and wait until the URL answers.

## 3. Prepare test data

Use test accounts and data only: from seed, fixture or example-config files, or create a new one through the app itself (for example sign up as `demo+<timestamp>@example.com` with a generated password). Never type the user's real credentials or personal data. If real credentials are unavoidable, ask the user to sign in themselves first.

## 4. Write a short shot list

Plan 5 to 10 steps for a 30 to 90 second video: the starting screen, the main action, the result, an optional second state, and a clear final screen. Share it with the user in a line or two, then go ahead unless something is unclear.

## 5. Connect

Ask the user to click the Recordful icon in Chrome on the tab with the app. Chrome requires that click before an extension can record a tab, and it also connects Recordful to you. Then call `get_status`.

The first time on a computer:
- `NOT_CONNECTED`: the user also turns on AI agents in Recordful (popup → More → AI agents, or paste `chrome-extension://hkcgjbkibidgbefehehenlmhjanjaopc/agents.html` into Chrome's address bar), then clicks the icon again.
- `PAIRING_PENDING`: Recordful opened a window asking to approve you. Tell the user the 4-digit code from the error so they can check it matches, and ask them to click Allow. Then retry.
- `PAIRING_DENIED`: stop and ask the user what they'd like to do.

If Recordful or the MCP server isn't installed, point the user to https://github.com/iKislay/recordful-mcp#install.

## 6. Record

1. `navigate` to the starting page and `snapshot` it. Make the starting state clean (signed out for a sign-in demo, no leftover data or open dialogs).
2. `start_recording`. It uses the user's Recordful settings (mode, microphone, camera, countdown) and returns once capture is live. `NOT_ARMED` means the user needs to click the Recordful icon on that tab.
3. Follow the shot list with the page tools. Take a fresh `snapshot` after anything that changes the page; refs from before a navigation stop working. Use `wait_for` so each result is on screen before you move on.
4. Call `pause_recording` whenever you need to think or plan, and `resume_recording` right before the next action, so the video has no dead air.
5. If something goes wrong (an error, the wrong page), pause, fix it, and resume. Start over only if the mistake would confuse viewers.
6. `stop_recording`. Recordful opens its editor with the video.

## 7. Wrap up

Tell the user the video is open in Recordful's editor, and summarise what it shows in one or two sentences.
