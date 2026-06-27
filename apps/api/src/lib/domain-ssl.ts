import type { Project } from "@repo/db";
import type { SslProvider, SslResult } from "@repo/adapters";
import { ForbiddenError, NotFoundError } from "@repo/core";
import { repos } from "@repo/db";
import { platform } from "./controller-helpers";
import { resolveDeploymentPlatform, type DeploymentMeta } from "./deployment-runtime";

export type DomainSslAction = "provision" | "renew";

interface DomainSslOptions {
  action: DomainSslAction;
  /** Restrict to a specific project (defense-in-depth; route layer
   *  already verified access). */
  projectId?: string;
  includeWww?: boolean;
}

async function resolveAuthorizedDomain(hostname: string, opts: DomainSslOptions) {
  const domainRecord = await repos.domain.findByHostname(hostname);
  if (!domainRecord) throw new NotFoundError("Domain", hostname);

  const project = await repos.project.findById(domainRecord.projectId);
  if (!project) throw new NotFoundError("Domain", hostname);

  // Access verification is enforced at the route boundary
  // (requirePermission middleware checks org membership before the
  // controller runs). The optional projectId is a defense-in-depth scope.
  if (opts.projectId && domainRecord.projectId !== opts.projectId) {
    throw new NotFoundError("Domain", hostname);
  }

  if (!domainRecord.verified) {
    throw new ForbiddenError("Domain must be verified before SSL can be managed");
  }

  return { domainRecord, project };
}

async function persistSslResult(domainId: string, result: SslResult) {
  await repos.domain.updateSsl(domainId, {
    sslStatus: result.expiresAt ? "active" : "provisioning",
    sslIssuer: result.issuer,
    sslExpiresAt: result.expiresAt ? new Date(result.expiresAt) : undefined,
  });
}

/**
 * Resolve the SSL provider that runs on the SAME host that serves the domain.
 *
 * certbot must execute on the box whose OpenResty serves the vhost and whose
 * `/var/www/acme` webroot answers the ACME HTTP-01 challenge. For a self-hosted
 * deploy targeting a remote SSH server, that box is the DEPLOY TARGET — not the
 * orchestrator the API booted on. The global `platform()` is the orchestrator,
 * so using it would run certbot on the wrong host (no vhost, no webroot → the
 * challenge can never succeed). Resolve the project's active-deployment platform
 * instead — the same per-server resolution the deploy itself used.
 *
 * Falls back to the global platform when the project has no active deployment
 * yet (single-box installs resolve to the same local provider either way).
 */
async function resolveSslProvider(project: Project): Promise<SslProvider> {
  const depId = project.activeDeploymentId;
  if (depId) {
    const dep = await repos.deployment.findById(depId);
    if (dep) {
      try {
        const resolved = await resolveDeploymentPlatform(
          (dep.meta ?? {}) as DeploymentMeta,
          { organizationId: dep.organizationId },
        );
        return resolved.platform.ssl;
      } catch {
        // Deploy target unresolvable/unreachable — fall back to the global
        // platform so a single-box install still works.
      }
    }
  }
  return platform().ssl;
}

async function executeSslAction(
  ssl: SslProvider,
  hostname: string,
  action: DomainSslAction,
): Promise<SslResult> {
  return action === "renew" ? ssl.renewCert(hostname) : ssl.provisionCert(hostname);
}

// NOTE on the toolchain (certbot/OpenResty): we deliberately do NOT install it
// here. Installing certbot can take 30–90s, which blows the renew HTTP request's
// timeout. Toolchain install lives in the DEPLOY step chain instead — the deploy
// preflight runs `system.ensureFeature("ssl", …)` whenever a planned domain has
// `provisionSsl` (see build-pipeline.ts), streaming the install logs into the
// deploy output. So a custom domain gets certbot installed AND its cert issued
// as part of a normal deploy; this on-demand path only issues/renews against an
// already-provisioned host (and surfaces a clear error if the toolchain is
// missing — i.e. "redeploy to set up SSL").
export async function manageDomainSsl(
  hostname: string,
  opts: DomainSslOptions,
): Promise<SslResult> {
  const { domainRecord, project } = await resolveAuthorizedDomain(hostname, opts);
  const ssl = await resolveSslProvider(project);
  const result = await executeSslAction(ssl, domainRecord.hostname, opts.action);
  await persistSslResult(domainRecord.id, result);

  if (opts.includeWww) {
    const wwwHostname = `www.${domainRecord.hostname}`;
    const wwwRecord = await repos.domain.findByHostname(wwwHostname);

    if (wwwRecord && wwwRecord.projectId === domainRecord.projectId && wwwRecord.verified) {
      // Same project → same host → reuse the resolved provider.
      const wwwResult = await executeSslAction(ssl, wwwRecord.hostname, opts.action);
      await persistSslResult(wwwRecord.id, wwwResult);
    }
  }

  return result;
}