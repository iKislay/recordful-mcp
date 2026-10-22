// AS on :4100 (better-auth), stub MCP resource server on :4200 (what the
// Worker would do: PRM + JWT verification against the AS's JWKS), and a CIMD
// document host on :4300.
import { createServer } from "node:http";
import { toNodeHandler } from "better-auth/node";
import { createMcpProtectedRequestHandler } from "@better-auth/mcp";
import { auth, AS, RESOURCE } from "./auth.mjs";

const toWeb = (req) =>
  new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers });
const sendWeb = async (res, r) => {
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
};

const authHandler = toNodeHandler(auth);
createServer(async (req, res) => {
  console.log("AS", req.method, req.url.split("?")[0]);
  // What POST /api/agent/relay-token would do in recordful-ee.
  if (req.url === "/relay-token" && req.method === "POST") {
    const session = await auth.api.getSession({ headers: new Headers({ authorization: req.headers.authorization || "" }) });
    if (!session) return sendWeb(res, Response.json({ error: "unauthenticated" }, { status: 401 }));
    const { token } = await auth.api.signJWT({
      body: {
        payload: {
          sub: session.user.id,
          sid: session.session.id,
          aud: "https://mcp.recordful.app/extension",
          scope: "relay:extension",
          exp: Math.floor(Date.now() / 1000) + 15 * 60,
        },
      },
    });
    return sendWeb(res, Response.json({ token }));
  }
  authHandler(req, res);
}).listen(4100);

export const issuer = process.env.JWT_ISSUER || `${AS}/api/auth`;
const protectedMcp = createMcpProtectedRequestHandler(
  { issuer, audience: RESOURCE, jwksUrl: `${AS}/api/auth/jwks`, requiredScopes: ["recording:control"] },
  async (_req, claims) => Response.json({ ok: true, claims }),
);
createServer(async (req, res) => {
  console.log("RS", req.method, req.url);
  if (req.url.startsWith("/.well-known/oauth-protected-resource")) {
    return sendWeb(
      res,
      Response.json({
        resource: RESOURCE,
        authorization_servers: [issuer],
        scopes_supported: ["recording:control"],
        bearer_methods_supported: ["header"],
        resource_name: "Recordful",
      }),
    );
  }
  if (req.url === "/mcp") return sendWeb(res, await protectedMcp(toWeb(req)));
  res.writeHead(404).end();
}).listen(4200);

createServer((req, res) => {
  console.log("CIMD", req.method, req.url);
  res.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=300" });
  res.end(
    JSON.stringify({
      client_id: "http://127.0.0.1:4300/client.json",
      client_name: "Spike Claude",
      client_uri: "http://127.0.0.1:4300",
      redirect_uris: ["http://127.0.0.1:4300/callback", "http://localhost/callback", "http://127.0.0.1/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  );
}).listen(4300);
console.log("listening 4100/4200/4300");
