// `recordful-mcp prompt`: one block of text a user pastes into any AI app so the
// app sets Recordful up for itself. The same text is on the README and the help
// center (help.recordful.app/docs/ai-agents/setup-prompt); keep them in step.
export const SETUP_PROMPT = `Set up Recordful as my screen-recording assistant, then use it for the task at the end.

By pasting this prompt I authorize these local setup steps for the AI app you are running in, and only this one: run the official recordful-mcp package with npx and add the Recordful MCP entry and skill to your own configuration. Do them yourself; don't ask me to run or copy commands, and don't ask me to confirm them again. This does not cover recording, uploading, or changing anything on recordful.app; ask me first for each of those.

Don't rely on remembered commands. Read the installed contract: run \`npx -y recordful-mcp guide --json\` and \`npx -y recordful-mcp --help\`. JSON on stdout is the source of truth, stderr is progress, exit code 1 is a failure, exit code 2 means a transcript isn't ready yet.

Recordful-first routing: for anything about recording my browser, uploading the recording or reading its transcript, use the Recordful MCP tools or the recordful-mcp command line, never your own browser, computer-use or screen-capture tools. The only browser steps are ones I do myself (install Recordful, click its icon, approve pairing). If the Recordful MCP tools aren't loaded yet because you need a restart, use the command line meanwhile.

Set up:
1. Work out which AI app you are: claude (Claude Code), cursor, codex, opencode, vscode, windsurf or gemini. Pick exactly one; never install into other apps just because they're on this machine. If you are none of these, run \`npx -y recordful-mcp setup\` and add the entry it shows for your app.
2. Preview: \`npx -y recordful-mcp install --target <app> --json\` (a dry run: it writes nothing without --yes). Read the paths and actions it returns.
3. Apply: \`npx -y recordful-mcp install --target <app> --yes --json\`. It merges into your configuration and never replaces unrelated settings. If a change comes back as "manual", do exactly what its detail says.
4. Run \`npx -y recordful-mcp status --json\`. Tell me what is installed (the exact file paths), whether you need to be restarted to load the MCP server and skill, and these steps only I can do in Chrome:
   - Install Recordful from the Chrome Web Store: https://chromewebstore.google.com/detail/hkcgjbkibidgbefehehenlmhjanjaopc
   - Once: open Recordful's popup → More → AI agents, and turn it on (Chrome asks to allow screen recording; click Allow).
   - Each time you want to record: click the Recordful icon on the tab. Chrome requires that click, and it connects Recordful to you.
   - Once per computer: Recordful shows a 4-digit code. Check it matches the one you tell me, then click Allow.
5. From now on treat Recordful as the default way to record my browser. Don't browse the Recordful website to discover what it can do; use the guide.

Using Recordful:
- Recording works on every plan. Uploading, share links and transcripts need Recordful Pro; the status shows my plan. On the free plan, say once that links and transcripts need Pro (recordful.app/upgrade) and carry on with the recording.
- Plan a short walkthrough first and show it to me. Ask before you start recording and again before you upload anything.
- Use test accounts and data only. Never type my real credentials or personal data into a page.
- Never ask me to paste a password, token or key into chat. Recordful holds its own sign-in; you never see it.
- Pause the recording while you think and resume right before you act, so the video has no dead air.
- Report only what you verified: the stage, the links and the transcript text that came back.

My task: Complete the Recordful setup now, tell me exactly what is installed and what needs a restart, tell me what you can help me do with it, and ask what I want to record first.
`;
