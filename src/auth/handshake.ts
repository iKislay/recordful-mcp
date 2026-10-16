// Mutual challenge-response over a shared token. Neither side ever sends the
// token itself, so a rogue process that grabs the port first learns nothing,
// and the extension refuses to take orders from a server that can't prove it
// holds the token (otherwise anything on 127.0.0.1 could start a recording).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type ProofRole = "client" | "server";

export const newNonce = (): string => randomBytes(32).toString("hex");

// The role prefix stops a proof from one direction being replayed as the other.
export const computeProof = (
  token: string,
  role: ProofRole,
  serverNonce: string,
  clientNonce: string,
): string =>
  createHmac("sha256", token)
    .update(`recordful-agent-bridge:${role}:${serverNonce}:${clientNonce}`)
    .digest("hex");

export const verifyProof = (expected: string, actual: string): boolean => {
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(actual, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
};
