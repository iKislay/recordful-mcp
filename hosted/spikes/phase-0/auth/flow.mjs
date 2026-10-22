// Drives the whole MCP OAuth flow against servers.mjs the way claude.ai /
// ChatGPT would, plus the Recordful-specific pieces (relay token, revoke).
import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";

const AS = "http://127.0.0.1:4100";
const API = `${AS}/api/auth`;
const RS = "http://127.0.0.1:4200";
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const b64url = (buf) => buf.toString("base64url");

let cookie = "";
const call = async (url, init = {}) => {
  const res = await fetch(url, {
    redirect: "manual",
    ...init,
    headers: { origin: AS, ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
  });
  const set = res.headers.getSetCookie?.() || [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  return res;
};
const json = async (res) => {
  const t = await res.text();
  try { return JSON.parse(t); } catch { return t; }
};

// 1. Discovery, as an MCP client does it: 401 → PRM → AS metadata.
const unauth = await call(`${RS}/mcp`, { method: "POST" });
const www = unauth.headers.get("www-authenticate") || "";
check("RS 401 carries resource_metadata", unauth.status === 401 && www.includes("resource_metadata"), www);
const prm = await json(await call(`${RS}/.well-known/oauth-protected-resource/mcp`));
const asMeta = await json(await call(`${AS}/.well-known/oauth-authorization-server/api/auth`));
check("AS metadata at issuer-inserted path", asMeta.issuer === prm.authorization_servers[0], asMeta.issuer);
check("CIMD advertised with auth method none",
  asMeta.client_id_metadata_document_supported === true && asMeta.token_endpoint_auth_methods_supported.includes("none"));
check("DCR advertised", !!asMeta.registration_endpoint);
check("PKCE S256 advertised", (asMeta.code_challenge_methods_supported || []).includes("S256"),
  JSON.stringify(asMeta.code_challenge_methods_supported));
console.log("      grant_types_supported:", asMeta.grant_types_supported.join(","));

// 2. User signs up / in on recordful.app.
const signUp = await call(`${API}/sign-up/email`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: `spike+${Date.now()}@example.com`, password: "spike-password-123", name: "Spike" }),
});
const signUpBody = await json(signUp);
check("sign up", signUp.ok, signUp.ok ? "" : JSON.stringify(signUpBody));
const sessionToken = signUpBody.token;

// 3a. DCR (ChatGPT/Cursor style).
const reg = await call(asMeta.registration_endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "Spike ChatGPT",
    redirect_uris: ["http://127.0.0.1:9999/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }),
});
const client = await json(reg);
check("DCR registers a public client", reg.status === 201 || reg.status === 200, client.client_id || JSON.stringify(client));

// 4. Authorization code + PKCE, with the consent page step.
const authorize = async (clientId, redirectUri, label) => {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "openid offline_access recording:control",
    state: "s1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: prm.resource,
  });
  // A browser navigation (Accept: text/html) gets a 302; a fetch gets {redirect, url}.
  let res = await call(`${asMeta.authorization_endpoint}?${q}`, { headers: { accept: "text/html" } });
  let loc = res.headers.get("location") || (await json(res)).url || "";
  check(`${label}: authorize sends the browser to the consent page`, loc.includes("/oauth/consent"), `${res.status} ${loc.slice(0, 80)}`);
  const search = new URL(loc, AS).search;
  const consent = await call(`${API}/oauth2/consent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accept: true, oauth_query: search.slice(1) }),
  });
  const consentBody = await json(consent);
  loc = consentBody.url || "";
  const code = new URL(loc || "http://x/").searchParams.get("code");
  check(`${label}: consent returns code to redirect_uri`, !!code && loc.startsWith(redirectUri), loc.slice(0, 120) || JSON.stringify(consentBody));
  const tok = await call(asMeta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: prm.resource,
    }),
  });
  const tokens = await json(tok);
  check(`${label}: token exchange`, tok.ok && !!tokens.access_token, tok.ok ? "" : JSON.stringify(tokens));
  return tokens;
};

const tokens = await authorize(client.client_id, "http://127.0.0.1:9999/callback", "DCR");
const claims = decodeJwt(tokens.access_token);
console.log("      access token claims:", JSON.stringify(claims));
check("access token is a JWT bound to the resource", [].concat(claims.aud).includes(prm.resource));
check("refresh token issued (offline_access)", !!tokens.refresh_token);

// 5. Resource server accepts it (what the Worker does).
const ok = await call(`${RS}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}` } });
check("RS accepts the access token", ok.ok, String(ok.status));
const jwks = createRemoteJWKSet(new URL(asMeta.jwks_uri));
const verified = await jwtVerify(tokens.access_token, jwks, { issuer: asMeta.issuer, audience: prm.resource }).then(() => true, (e) => e.message);
check("jose verifies against JWKS (Worker path)", verified === true, verified === true ? "" : verified);

// 5b. A better-auth session token must not work at the RS.
const sess = await call(`${RS}/mcp`, { method: "POST", headers: { authorization: `Bearer ${sessionToken}` } });
check("RS rejects a session token", sess.status === 401, String(sess.status));

// 6. Refresh.
const ref = await call(asMeta.token_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id, resource: prm.resource }),
});
const refreshed = await json(ref);
check("refresh token grant", ref.ok && !!refreshed.access_token, ref.ok ? "" : JSON.stringify(refreshed));

// 3b. CIMD (Claude style): client_id is a URL.
// Claude Code's real, public metadata document, fetched with the production
// Node transport (resolve-once DNS, public addresses only, no redirects).
const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata";
const cimdTokens = await authorize(CLAUDE_CODE, "http://127.0.0.1:53127/callback", "CIMD (Claude Code) 127.0.0.1 any port").catch((e) => {
  check("CIMD flow", false, e.message);
  return null;
});
// Claude Code: loopback redirect on an arbitrary port, declared without one.
await authorize(CLAUDE_CODE, "http://localhost:61002/callback", "CIMD (Claude Code) localhost any port").catch((e) =>
  check("CIMD loopback any port", false, e.message),
);

// 7. Relay token for the extension: signed with the same key, own audience.
const relay = await fetch(`${AS}/relay-token`, { method: "POST", headers: { authorization: `Bearer ${sessionToken}` } });
const relayJwt = (await json(relay)).token;
const relayOk = await jwtVerify(relayJwt, jwks, { issuer: AS, audience: "https://mcp.recordful.app/extension" }).then((r) => r.payload, (e) => e.message);
check("relay token signed by the same JWKS, own audience", typeof relayOk === "object", JSON.stringify(relayOk));
const crossUse = await jwtVerify(relayJwt, jwks, { issuer: asMeta.issuer, audience: prm.resource }).then(() => "accepted", () => "rejected");
check("relay token is not accepted as an MCP access token", crossUse === "rejected");

// 8. Consents listing and revoke (account page).
const consents = await json(await call(`${API}/oauth2/get-consents`));
check("list consents for the account page", Array.isArray(consents) && consents.length >= 1, JSON.stringify(consents).slice(0, 200));
const del = await call(`${API}/oauth2/delete-consent`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: consents[0]?.id }),
});
check("delete consent", del.ok, String(del.status) + " " + JSON.stringify(await json(del)).slice(0, 200));
const ref2 = await call(asMeta.token_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshed.refresh_token, client_id: client.client_id, resource: prm.resource }),
});
check("refresh fails after consent is deleted", !ref2.ok, String(ref2.status) + " " + JSON.stringify(await json(ref2)).slice(0, 200));
const revoke = await call(asMeta.revocation_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ token: cimdTokens?.refresh_token || "", token_type_hint: "refresh_token", client_id: CLAUDE_CODE }),
});
check("RFC 7009 revoke by public client", revoke.ok, String(revoke.status) + " " + JSON.stringify(await json(revoke)).slice(0, 200));
if (cimdTokens) {
  const after = await call(asMeta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: cimdTokens.refresh_token, client_id: CLAUDE_CODE, resource: prm.resource }),
  });
  check("refresh fails after RFC 7009 revoke", !after.ok, String(after.status));
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(0);
