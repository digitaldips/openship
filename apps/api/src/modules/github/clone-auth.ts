/**
 * @module clone-auth
 *
 * Thin adapter over the unified token dispatcher in `github.token.ts` for
 * the deploy pipeline. The dispatcher (`tokenFor(userId, purpose, ctx)`)
 * already encodes the full priority chain; this file only translates the
 * deploy-specific `buildStrategy` discriminator into a `purpose`:
 *
 *   - buildStrategy="local"  → tokenFor(..., "local")
 *   - buildStrategy="server" → requireTokenFor(..., "remote")
 *
 * gh CLI tokens are never returned for "remote" — that policy lives in
 * `tokenFor("remote", ...)` and the rejection happens before this
 * function ever sees a token.
 *
 * Token priority (single source of truth — see github.token.ts):
 *   - purpose: "local"  → project > user-pat > gh CLI > App > OAuth
 *   - purpose: "remote" → project > user-pat > App > REFUSE (no gh CLI)
 */

import { type BuildStrategy } from "@repo/core";
import { tokenFor, requireTokenFor, type TokenContext } from "./github.token";
import type { RequestContext } from "../../lib/request-context";

export async function resolveBuildGitToken(opts: {
  /** Caller's request context. Carries userId + organizationId; org-scoped
   *  App installation lookup uses ctx.organizationId. */
  ctx: RequestContext;
  projectId: string;
  owner?: string | null;
  /** Repo name — threaded to the github-access gate for PER-REPO
   *  authorization (so a member granted only repo X can build X). */
  repo?: string | null;
  buildStrategy: BuildStrategy;
}): Promise<string | null> {
  const tokenCtx: TokenContext = {
    projectId: opts.projectId,
    owner: opts.owner ?? undefined,
    repo: opts.repo ?? undefined,
  };

  if (opts.buildStrategy === "local") {
    // LOCAL build: clone + build run on THIS host, the token never leaves it,
    // and we're already authenticated via gh — so use the local gh token
    // DIRECTLY, no SaaS App-token fetch. (Same rule as local READS in
    // githubFetch: local op → gh.) Falls through to the full resolver chain
    // (App installation / project PAT / user PAT / OAuth) only when there's no
    // local gh. getLocalGhToken self-guards to null in CLOUD_MODE.
    const { getLocalGhToken } = await import("./github.local-auth");
    const ghToken = await getLocalGhToken();
    if (ghToken) return ghToken;

    const r = await tokenFor(opts.ctx, "local", tokenCtx);
    return r?.token ?? null;
  }

  // SERVER / REMOTE build: the clone/build runs off this host (server's Docker
  // daemon, cloud workspace), so we fetch the SaaS-minted App installation
  // token (short-lived, repo-scoped) — gh is REFUSED here (HIGH #7: never ship
  // the operator's broad token off-host). requireTokenFor throws an actionable
  // error if nothing is resolvable.
  const r = await requireTokenFor(opts.ctx, "remote", tokenCtx);
  return r.token;
}
