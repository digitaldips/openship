import type { Context } from "hono";
import { repos, type Permission, type PublicPersonalAccessToken } from "@repo/db";
import { param } from "../../lib/controller-helpers";
import { getRequestContext, type RequestContext } from "../../lib/request-context";
import { checkPermission } from "../../lib/permission";
import { canUseGitHubRepo } from "../github/github-access";
import { mintPatToken } from "../../lib/pat";
import type { TCreateTokenBody } from "./token.schema";

/** Resource types a token may be scoped to (mirrors the picker + grants API). */
const GRANTABLE_TOKEN_TYPES = new Set<string>([
  "project",
  "server",
  "mail_server",
  "backup_destination",
  "billing",
  "audit",
  "github_installation",
  "github_repository",
]);

/** Public view of a token — NEVER includes the hash or the plaintext. */
function serialize(t: PublicPersonalAccessToken) {
  return {
    id: t.id,
    name: t.name,
    tokenPrefix: t.tokenPrefix,
    readOnly: t.readOnly,
    scoped: t.scoped,
    expiresAt: t.expiresAt,
    lastUsedAt: t.lastUsedAt,
    revokedAt: t.revokedAt,
    createdAt: t.createdAt,
  };
}

/** The strongest action a grant's permissions imply. */
function strongestAction(perms: Permission[]): Permission {
  if (perms.includes("admin")) return "admin";
  if (perms.includes("write")) return "write";
  return "read";
}

/**
 * A token can only grant access the MINTER already has — reuses the live
 * permission path (owner ⇒ everything; others ⇒ their own grants). GitHub goes
 * through its dedicated gate.
 */
async function minterHasAccess(
  ctx: RequestContext,
  g: { resourceType: string; resourceId: string; permissions: Permission[] },
): Promise<boolean> {
  const action = strongestAction(g.permissions);
  if (g.resourceType === "github_installation" || g.resourceType === "github_repository") {
    const op = action === "read" ? "read" : "write";
    const [owner, repo] =
      g.resourceType === "github_repository" ? g.resourceId.split("/") : [g.resourceId, undefined];
    return canUseGitHubRepo(ctx, { owner: owner ?? "", repo: repo ?? null }, op);
  }
  return checkPermission(ctx.userId, ctx.organizationId, {
    resourceType: g.resourceType as never,
    resourceId: g.resourceId,
    action,
  });
}

/** POST /api/tokens — mint a token. Returns the plaintext ONCE. */
export async function create(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<TCreateTokenBody>();

  // A scoped token carries its own grants. Validate every grant is within the
  // minter's own access BEFORE minting, so a token can never exceed its owner.
  const grants = (body.grants ?? []).filter((g) => g.permissions.length > 0);
  const wantScoped = grants.length > 0;
  if (wantScoped) {
    for (const g of grants) {
      if (!GRANTABLE_TOKEN_TYPES.has(g.resourceType)) {
        return c.json(
          { error: `Invalid resource type: ${g.resourceType}`, code: "INVALID_RESOURCE_TYPE" },
          400,
        );
      }
      if (!(await minterHasAccess(ctx, g))) {
        return c.json(
          {
            error: `You can't grant access you don't have yourself: ${g.resourceType} / ${g.resourceId}`,
            code: "GRANT_EXCEEDS_ACCESS",
          },
          403,
        );
      }
    }
  }

  const { token, tokenPrefix, tokenHash } = mintPatToken();
  const expiresAt = body.expiresInDays
    ? new Date(Date.now() + body.expiresInDays * 86_400_000)
    : null;

  const row = await repos.personalAccessToken.create({
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    name: body.name,
    tokenPrefix,
    tokenHash,
    readOnly: body.readOnly ?? false,
    scoped: wantScoped,
    expiresAt,
  });

  if (wantScoped) {
    await repos.patGrant.createMany(
      row.id,
      grants.map((g) => ({
        resourceType: g.resourceType as never,
        resourceId: g.resourceId,
        permissions: g.permissions,
      })),
    );
  }

  // `token` is shown exactly once — it's never retrievable again.
  return c.json({ data: { ...serialize(row), token } }, 201);
}

/** GET /api/tokens — the caller's own tokens (no secrets). */
export async function list(c: Context) {
  const ctx = getRequestContext(c);
  const rows = await repos.personalAccessToken.listByUser(ctx.userId);
  return c.json({ data: rows.map(serialize) });
}

/** DELETE /api/tokens/:id — revoke one of the caller's own tokens. */
export async function revoke(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  const ok = await repos.personalAccessToken.revoke(id, ctx.userId);
  if (!ok) return c.json({ error: "Token not found" }, 404);
  return c.json({ data: { revoked: true } });
}

/**
 * POST /api/tokens/mcp-authorize — record what an OAuth MCP client may access,
 * BEFORE the Better Auth consent completes and a token is issued.
 *
 * Called by the /mcp/authorize consent page (browser cookie session). Persists
 * the user's chosen read-only + resource grants as the OAuth client's binding
 * (a scoped `personal_access_token` grant-holder keyed by user+client). The
 * OAuth access token then resolves to that binding at auth time
 * (`tryOAuthMcpAuth`) and runs through the SAME scoped-principal path as a PAT.
 *
 * Grants are validated ⊆ the caller's own access (identical rule to token
 * creation), so a client can never be granted more than the user holds.
 */
export async function authorizeMcpClient(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<{
    clientId?: string;
    readOnly?: boolean;
    grants?: Array<{ resourceType: string; resourceId: string; permissions: Permission[] }>;
  }>();

  const clientId = body.clientId?.trim();
  if (!clientId) return c.json({ error: "clientId required", code: "CLIENT_ID_REQUIRED" }, 400);

  const grants = (body.grants ?? []).filter((g) => g.permissions.length > 0);
  const scoped = grants.length > 0;

  for (const g of grants) {
    if (!GRANTABLE_TOKEN_TYPES.has(g.resourceType)) {
      return c.json(
        { error: `Invalid resource type: ${g.resourceType}`, code: "INVALID_RESOURCE_TYPE" },
        400,
      );
    }
    if (!(await minterHasAccess(ctx, g))) {
      return c.json(
        {
          error: `You can't grant access you don't have yourself: ${g.resourceType} / ${g.resourceId}`,
          code: "GRANT_EXCEEDS_ACCESS",
        },
        403,
      );
    }
  }

  const binding = await repos.personalAccessToken.upsertOAuthBinding({
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    oauthClientId: clientId,
    readOnly: body.readOnly ?? false,
    scoped,
  });

  // Replace the binding's grants wholesale (re-authorizing overwrites).
  await repos.patGrant.deleteByToken(binding.id);
  if (scoped) {
    await repos.patGrant.createMany(
      binding.id,
      grants.map((g) => ({
        resourceType: g.resourceType as never,
        resourceId: g.resourceId,
        permissions: g.permissions,
      })),
    );
  }

  return c.json({ data: { ok: true, scoped, readOnly: binding.readOnly } });
}
