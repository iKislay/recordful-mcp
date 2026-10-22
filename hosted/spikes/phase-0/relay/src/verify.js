// Does the Worker runtime verify recordful.app-style tokens (EdDSA/Ed25519 via
// JWKS), both with plain jose and with better-auth's own resource-server helper?
import { createRemoteJWKSet, jwtVerify } from "jose";
import { createMcpProtectedRequestHandler } from "@better-auth/mcp";

const AS = "http://127.0.0.1:4100/api/auth";
const RESOURCE = "http://127.0.0.1:4200/mcp";
const jwks = createRemoteJWKSet(new URL(`${AS}/jwks`));
const helper = createMcpProtectedRequestHandler(
  { issuer: AS, audience: RESOURCE, jwksUrl: `${AS}/jwks`, requiredScopes: ["recording:control"] },
  async (_req, claims) => Response.json({ via: "better-auth helper", sub: claims.sub, scope: claims.scope }),
);

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/jose") {
      const token = (request.headers.get("authorization") || "").replace(/^Bearer /, "");
      try {
        const { payload, protectedHeader } = await jwtVerify(token, jwks, { issuer: AS, audience: RESOURCE });
        return Response.json({ via: "jose", alg: protectedHeader.alg, sub: payload.sub });
      } catch (e) {
        return Response.json({ error: e.message }, { status: 401 });
      }
    }
    return helper(request);
  },
};
