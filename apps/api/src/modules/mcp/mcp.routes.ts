/**
 * MCP endpoint — mounted at /api/mcp in app.ts. A stateless Streamable-HTTP
 * JSON-RPC endpoint. It is a PUBLIC route (no auto-injected authMiddleware):
 * it authenticates the PAT itself, and every tool call dispatches an internal
 * request that re-runs the full auth + permission stack (see mcp-dispatch.ts).
 */

import { Hono } from "hono";
import { repos } from "@repo/db";
import { secureRouter } from "../../lib/secure-router";
import { hashPatToken } from "../../lib/pat";
import { isPatToken, parseBearerToken } from "../../lib/bearer";
import { auth } from "../../lib/auth";
import { handleMcpMessage, jsonRpcError } from "./mcp-server";

const r = secureRouter(new Hono(), { module: "mcp", basePath: "/api/mcp" });

const PUBLIC_REASON =
  "MCP JSON-RPC endpoint; authenticates via PAT bearer and re-checks auth on every dispatched tool call";

// This server doesn't push server→client messages, so GET (SSE stream) is 405.
r.public("get", "/", { reason: PUBLIC_REASON }, (c) => c.body(null, 405));

// Same tight per-IP budget as the auth endpoints — unauthenticated PAT probes
// run a DB lookup, so cap them well below the default-anon rate.
r.public("post", "/", { reason: PUBLIC_REASON, rateLimit: "auth-tight" }, async (c) => {
  const token = parseBearerToken(c);

  // Resource-server 401: a missing/invalid credential returns 401 with a
  // `WWW-Authenticate` header pointing at the Protected Resource Metadata, so
  // OAuth-2.1 MCP clients discover the authorization server and start the flow.
  const unauthorized = () =>
    c.json(jsonRpcError(null, -32001, "Missing or invalid access token"), 401, {
      "WWW-Authenticate": `Bearer resource_metadata="${new URL(c.req.url).origin}/.well-known/oauth-protected-resource"`,
    });

  if (!token) return unauthorized();

  // Accept BOTH credentials: a PAT (API-key path) or an OAuth access token
  // (mcp() plugin). This is only a shallow gate — the real per-tool
  // authorization runs on the dispatched sub-request through authMiddleware
  // (which now resolves either credential; see tryPatAuth / tryOAuthMcpAuth).
  let authed = false;
  if (isPatToken(token)) {
    authed = !!(await repos.personalAccessToken.findActiveByHash(hashPatToken(token)));
  } else {
    try {
      authed = !!(await auth.api.getMcpSession({ headers: c.req.raw.headers }));
    } catch {
      authed = false;
    }
  }
  if (!authed) return unauthorized();

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json(jsonRpcError(null, -32700, "Parse error"), 400);
  }

  // 2025-06-18 removed JSON-RPC batching; accept a single message only.
  if (Array.isArray(payload)) {
    return c.json(jsonRpcError(null, -32600, "Batch requests are not supported"), 400);
  }

  const res = await handleMcpMessage(payload as Parameters<typeof handleMcpMessage>[0], token);
  // Notification (no id) → 202 Accepted with no body (per JSON-RPC).
  if (!res) return c.body(null, 202);
  return c.json(res);
});

export const mcpRoutes = r.hono;
