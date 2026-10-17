// Machine-wide bridge state: one server identity plus the extensions that
// paired with it. Every recordful-mcp process the user's AI apps start shares
// this file, so the user pairs once per machine, not once per app.
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { PairingSecret } from "../protocol/messages.js";

export const MIN_STATIC_SECRET_LENGTH = 32;

const PairingRecord = z.object({
  secret: PairingSecret,
  pairedAt: z.string(),
  app: z.string(),
});
export type PairingRecord = z.infer<typeof PairingRecord>;

const StateFileV2 = z.object({
  version: z.literal(2),
  serverId: z.string().uuid(),
  createdAt: z.string(),
  pairings: z.record(z.string(), PairingRecord),
  // A v0.1 token, kept so development builds that baked it in still connect.
  legacyToken: z.string().min(MIN_STATIC_SECRET_LENGTH).optional(),
});
type StateFileV2 = z.infer<typeof StateFileV2>;

const StateFileV1 = z.object({
  version: z.literal(1),
  token: z.string().min(MIN_STATIC_SECRET_LENGTH),
  createdAt: z.string(),
});

export const defaultStatePath = (): string => join(homedir(), ".recordful", "agent-bridge.json");

export interface PairingSummary {
  extensionId: string;
  app: string;
  pairedAt: string;
}

export class PairingStore {
  readonly path: string;
  readonly serverId: string;
  private readonly staticSecrets: string[];

  private constructor(path: string, serverId: string, staticSecrets: string[]) {
    this.path = path;
    this.serverId = serverId;
    this.staticSecrets = staticSecrets;
  }

  // envSecret (RECORDFUL_BRIDGE_TOKEN) is a shared secret any allowed
  // extension may use instead of pairing: for CI and scripted test runs.
  static async open(
    opts: { path?: string; envSecret?: string | undefined } = {},
  ): Promise<PairingStore> {
    const path = opts.path ?? defaultStatePath();
    if (opts.envSecret && opts.envSecret.length < MIN_STATIC_SECRET_LENGTH) {
      throw new Error(`RECORDFUL_BRIDGE_TOKEN must be at least ${MIN_STATIC_SECRET_LENGTH} characters`);
    }
    const state = await loadOrCreate(path);
    const staticSecrets = [opts.envSecret, state.legacyToken].filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
    return new PairingStore(path, state.serverId, staticSecrets);
  }

  // Secrets this extension may sign with. Re-read on every call: another
  // recordful-mcp process may have paired since this one started.
  async secretsFor(extensionId: string): Promise<string[]> {
    const state = await readState(this.path);
    const paired = state?.pairings[extensionId]?.secret;
    return paired ? [paired, ...this.staticSecrets] : [...this.staticSecrets];
  }

  async save(extensionId: string, secret: string, app: string): Promise<void> {
    PairingSecret.parse(secret);
    const state = (await readState(this.path)) ?? (await loadOrCreate(this.path));
    state.pairings[extensionId] = { secret, app, pairedAt: new Date().toISOString() };
    await writeState(this.path, state);
  }

  // Forgets one extension, or every pairing when extensionId is omitted.
  async remove(extensionId?: string): Promise<number> {
    const state = await readState(this.path);
    if (!state) return 0;
    const before = Object.keys(state.pairings).length;
    if (extensionId) delete state.pairings[extensionId];
    else state.pairings = {};
    await writeState(this.path, state);
    return before - Object.keys(state.pairings).length;
  }

  async list(): Promise<PairingSummary[]> {
    const state = await readState(this.path);
    return Object.entries(state?.pairings ?? {}).map(([extensionId, p]) => ({
      extensionId,
      app: p.app,
      pairedAt: p.pairedAt,
    }));
  }
}

const readState = async (path: string): Promise<StateFileV2 | null> => {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON; fix or delete it (${(err as Error).message})`);
  }
  const v2 = StateFileV2.safeParse(json);
  if (v2.success) return v2.data;
  const v1 = StateFileV1.safeParse(json);
  if (v1.success) {
    return {
      version: 2,
      serverId: randomUUID(),
      createdAt: v1.data.createdAt,
      pairings: {},
      legacyToken: v1.data.token,
    };
  }
  throw new Error(`${path} has an unknown format; fix or delete it`);
};

const loadOrCreate = async (path: string): Promise<StateFileV2> => {
  const existing = await readState(path);
  if (existing) {
    // Persist a v1 migration so every process agrees on the new serverId.
    const onDisk = JSON.parse(await readFile(path, "utf8")) as { version?: number };
    if (onDisk.version !== 2) await writeState(path, existing);
    return existing;
  }
  const fresh: StateFileV2 = {
    version: 2,
    serverId: randomUUID(),
    createdAt: new Date().toISOString(),
    pairings: {},
  };
  await writeState(path, fresh);
  return fresh;
};

// Write-then-rename so a crash or a concurrent reader never sees half a file.
const writeState = async (path: string, state: StateFileV2): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  // mode is honoured on POSIX; on Windows the file inherits the profile ACL,
  // which already limits it to the user.
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => {});
};
