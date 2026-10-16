// The pairing token lives in a per-user file so every MCP client on this
// machine (Claude Code, Claude Desktop, Cursor...) shares one pairing with the
// extension. RECORDFUL_BRIDGE_TOKEN overrides it for CI and containers.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export const MIN_TOKEN_LENGTH = 32;

const TokenFile = z.object({
  version: z.literal(1),
  token: z.string().min(MIN_TOKEN_LENGTH),
  createdAt: z.string(),
});

export const defaultTokenPath = (): string =>
  join(homedir(), ".recordful", "agent-bridge.json");

export const generateToken = (): string => randomBytes(32).toString("base64url");

export type TokenSource = "env" | "file" | "generated";

export interface LoadedToken {
  token: string;
  source: TokenSource;
  path: string;
}

const writeTokenFile = async (path: string, token: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const body = JSON.stringify(
    { version: 1, token, createdAt: new Date().toISOString() },
    null,
    2,
  );
  // mode is honoured on POSIX; on Windows the file inherits the profile ACL,
  // which already limits it to the user.
  await writeFile(path, `${body}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
};

export const loadOrCreateToken = async (
  opts: { path?: string; envToken?: string | undefined; rotate?: boolean } = {},
): Promise<LoadedToken> => {
  const path = opts.path ?? defaultTokenPath();

  if (opts.envToken !== undefined && opts.envToken !== "") {
    if (opts.envToken.length < MIN_TOKEN_LENGTH) {
      throw new Error(
        `RECORDFUL_BRIDGE_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`,
      );
    }
    return { token: opts.envToken, source: "env", path };
  }

  if (!opts.rotate) {
    try {
      const parsed = TokenFile.parse(JSON.parse(await readFile(path, "utf8")));
      return { token: parsed.token, source: "file", path };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(
          `Token file ${path} is unreadable or malformed; fix or delete it (${(err as Error).message})`,
        );
      }
    }
  }

  const token = generateToken();
  await writeTokenFile(path, token);
  return { token, source: "generated", path };
};
