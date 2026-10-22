// Phase 0 spike: better-auth 1.7.12 as the MCP authorization server, configured
// the way recordful.app would be (bearer + jwt + mcp + cimd, DCR on).
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { bearer, jwt } from "better-auth/plugins";
import { mcp } from "@better-auth/mcp";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";

export const AS = "http://127.0.0.1:4100";
export const RESOURCE = "http://127.0.0.1:4200/mcp";

const db = Object.fromEntries("user session account verification jwks oauthClient oauthResource oauthClientResource oauthRefreshToken oauthAccessToken oauthConsent oauthClientAssertion".split(" ").map((t) => [t, []]));
export const memory = db;

// CIMD: the node transport refuses non-public addresses, so loopback test docs
// go through a plain fetch here. Production keeps fetchClientMetadataResource.
const spikeFetch = async (url, init) => {
  if (new URL(url).hostname === "127.0.0.1") return fetch(url, { ...init, redirect: "manual" });
  return fetchClientMetadataResource(url, init);
};

export const auth = betterAuth({
  baseURL: AS,
  secret: "spike-secret-spike-secret-spike-secret-0123",
  database: memoryAdapter(db),
  emailAndPassword: { enabled: true },
  plugins: [
    bearer(),
    jwt(process.env.JWT_ISSUER ? { jwt: { issuer: process.env.JWT_ISSUER } } : undefined),
    mcp({
      resource: RESOURCE,
      loginPage: "/login",
      consentPage: "/oauth/consent",
      scopes: ["openid", "profile", "email", "offline_access", "recording:control"],
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      clientRegistrationDefaultApplicationType: "infer",
      accessTokenExpiresIn: 600,
      grantTypes: ["authorization_code", "refresh_token"],
    }),
    cimd({ fetchClientMetadataResource: spikeFetch, metadataProfile: "mcp-2026-07-28" }),
  ],
});
