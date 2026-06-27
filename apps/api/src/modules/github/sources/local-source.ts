/**
 * LocalGitHubSource — the MERGE. Self-hosted only.
 *
 * Composes an optional gh sub-source (GhCliSource, resolved from a LOCAL token
 * read at construction) + a LAZILY-resolved App sub-source (GitHubAppSource),
 * and OWNS the per-capability source order the wrappers used to scatter:
 *   - listing  → gh-FIRST (local, ZERO cloud), else App, else user-token.
 *   - clone    → App/cloud-first, gh refused for remote (delegated to tokenFor,
 *                whose self-hosted chain already encodes this).
 *   - status   → both sides composed.
 *
 * CRITICAL: the cloud mode-probe (resolveGitHubAuthMode → isCloudConnectedForOrg
 * → /cloud/account) happens ONLY inside `app()`, which gh-first listing never
 * calls. So a plain library browse with gh logged in is 100% local.
 *
 * Constructed only in non-CLOUD_MODE (see ./index.ts). The SaaS uses
 * GitHubAppSource directly.
 */

import { listUserOwnedRepos } from "../github.service";
import {
  getGitHubConnectionState,
  getInstallationId,
  getInstallationToken,
  getUserInstallations,
  getUserStatus,
  resolveGitHubAuthMode,
  resolveInstallUrl,
} from "../github.auth";
import { tokenFor, canResolveTokenFor } from "../github.token";
import type {
  GitHubPurpose,
  GitHubTokenSource,
  TokenContext,
  TokenResult,
} from "../github.token";
import type { RequestContext } from "../../../lib/request-context";
import type {
  GitHubConnectionState,
  GitHubInstallation,
  MappedRepository,
} from "../github.types";
import type { GhCliSource } from "./gh-cli-source";
import type { GitHubAppSource } from "./app-source";
import type {
  GitHubConnectionStatus,
  GitHubHome,
  GitHubInstallUrl,
  GitHubMode,
  GitHubSource,
  GitHubUserStatus,
} from "./types";

export class LocalGitHubSource implements GitHubSource {
  // Listing-facing label; the App side (cloud-app/app) is resolved lazily and
  // is not reflected here. `mode` is informational — nothing dispatches on it.
  readonly mode: GitHubMode = "cli";

  private appResolved = false;
  private appValue: GitHubAppSource | null = null;

  constructor(
    private readonly ctx: RequestContext,
    private readonly gh: GhCliSource | null,
  ) {}

  /**
   * Resolve the App sub-source on demand. THE ONLY place the cloud mode is
   * probed (resolveGitHubAuthMode → isCloudConnectedForOrg → /cloud/account),
   * so gh-first listing never triggers a cloud round-trip. Memoized per source.
   */
  private async app(): Promise<GitHubAppSource | null> {
    if (this.appResolved) return this.appValue;
    const mode = await resolveGitHubAuthMode(this.ctx);
    if (mode === "cloud-app" || mode === "app") {
      const { GitHubAppSource } = await import("./app-source");
      this.appValue = new GitHubAppSource(this.ctx, mode);
    }
    this.appResolved = true;
    return this.appValue;
  }

  // ── Listing: gh-FIRST → App → user-token ─────────────────────────────────
  async listReposForOwner(owner?: string): Promise<MappedRepository[] | null> {
    if (this.gh) return this.gh.listReposForOwner(owner);
    const app = await this.app();
    if (app) return app.listReposForOwner(owner);
    // user-token (OAuth/PAT): the user's OWN account must go to /user/repos —
    // /orgs/{me}/repos 404s for a user account.
    const status = await getUserStatus(this.ctx.userId);
    const isOwn = !!owner && status.connected && owner === status.login;
    return listUserOwnedRepos(this.ctx, isOwn ? undefined : owner);
  }

  async getHome(): Promise<GitHubHome> {
    // gh-FIRST: a LOCAL read, ZERO cloud. We never call app() here — the App's
    // connection status is surfaced separately by the Settings card.
    if (this.gh) {
      const status = await this.gh.status();
      const [repos, accounts] = await Promise.all([
        this.gh.listAllRepos(),
        this.gh.listOwners(),
      ]);
      const state: GitHubConnectionState = {
        sources: {
          openshipApp: { connected: false },
          ghCli: status.available
            ? { available: true, login: status.login, avatarUrl: status.avatar_url }
            : { available: true },
        },
        primary: "gh-cli",
      };
      return { state, accounts, repos };
    }

    // No gh → App home (installations) when the App is present.
    const app = await this.app();
    if (app) return app.getHome();

    // Neither → user-token (OAuth/PAT) home, or the empty shell when nothing
    // is connected at all.
    const state = await getGitHubConnectionState(this.ctx);
    if (state.primary === null) return { state, accounts: [], repos: [] };
    const repos = await listUserOwnedRepos(this.ctx);
    return { state, accounts: [], repos };
  }

  // ── Connection status: compose both sides (Settings card; probes cloud) ──
  async getConnectionState(): Promise<GitHubConnectionState> {
    const app = await this.app();
    const [appState, ghStatus] = await Promise.all([
      app ? app.getConnectionState() : Promise.resolve(null),
      this.gh ? this.gh.status() : Promise.resolve({ available: false } as const),
    ]);
    const openshipApp = appState?.sources.openshipApp ?? { connected: false };
    const ghCli = ghStatus.available
      ? { available: true, login: ghStatus.login, avatarUrl: ghStatus.avatar_url }
      : { available: false };
    return {
      sources: { openshipApp, ghCli },
      primary: openshipApp.connected ? "openship-app" : ghCli.available ? "gh-cli" : null,
    };
  }

  async getConnectionStatus(): Promise<GitHubConnectionStatus> {
    const [state, app] = await Promise.all([this.getConnectionState(), this.app()]);
    const accounts = app ? (await app.getConnectionStatus()).accounts : [];
    return { state, accounts };
  }

  // ── Delegated primitives (gh-free real impls in github.auth/token) ───────
  getUserStatus(): Promise<GitHubUserStatus> {
    return getUserStatus(this.ctx.userId);
  }

  getUserInstallations(): Promise<GitHubInstallation[]> {
    return getUserInstallations(this.ctx);
  }

  getInstallationId(owner: string): Promise<number | null> {
    return getInstallationId(this.ctx, owner);
  }

  getInstallationToken(owner: string, installationId?: number): Promise<string | null> {
    return getInstallationToken(this.ctx, owner, installationId);
  }

  resolveInstallUrl(): Promise<GitHubInstallUrl> {
    return resolveInstallUrl(this.ctx);
  }

  tokenFor(purpose: GitHubPurpose, tokenCtx: TokenContext = {}): Promise<TokenResult | null> {
    return tokenFor(this.ctx, purpose, tokenCtx);
  }

  canResolveTokenFor(
    purpose: GitHubPurpose,
    tokenCtx: TokenContext = {},
  ): Promise<GitHubTokenSource | null> {
    return canResolveTokenFor(this.ctx, purpose, tokenCtx);
  }
}
