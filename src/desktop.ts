// The Recordful desktop app, for screenshots of a whole screen, a window or an
// area (take_screenshot with a desktop source, list_windows). Once the user
// turns on Settings → AI agents in the app, it opens a localhost endpoint and
// writes its port and a token to ~/.recordful/desktop-agent.json, readable only
// by that user. Nothing else connects it: no pairing, no extension.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { BridgeError, ErrorCode } from "./protocol/errors.js";

export const desktopFile = (): string =>
  process.env.RECORDFUL_DESKTOP_AGENT_FILE ?? join(homedir(), ".recordful", "desktop-agent.json");

const notTurnedOn = () =>
  new BridgeError(
    ErrorCode.NotConnected,
    "The Recordful desktop app isn't letting AI agents take screenshots.",
    {
      hint: 'Ask the user to open the Recordful desktop app, then Settings → AI agents → turn on "Let AI agents take screenshots", and retry. No desktop app? https://recordful.app/download',
    },
  );

/** Calls the desktop app; its JSON answer. */
export async function desktopCall(
  route: string,
  init: { method?: "GET" | "POST"; body?: unknown } = {},
  timeoutMs = 120_000,
): Promise<Record<string, unknown>> {
  let agent: { port?: unknown; token?: unknown };
  try {
    agent = JSON.parse(await readFile(desktopFile(), "utf8"));
  } catch {
    throw notTurnedOn();
  }
  if (typeof agent.port !== "number" || typeof agent.token !== "string") throw notTurnedOn();
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${agent.port}${route}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${agent.token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError")
      throw new BridgeError(ErrorCode.Timeout, `The desktop app didn't answer within ${timeoutMs / 1000}s.`);
    throw new BridgeError(ErrorCode.NotConnected, "The Recordful desktop app isn't running.", {
      hint: "Ask the user to open the Recordful desktop app, then retry.",
    });
  }
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status === 401) throw notTurnedOn();
  if (!response.ok)
    throw new BridgeError(
      response.status === 400 ? ErrorCode.InvalidParams : ErrorCode.Internal,
      typeof data.error === "string" ? data.error : `The desktop app answered ${response.status}.`,
    );
  return data;
}
