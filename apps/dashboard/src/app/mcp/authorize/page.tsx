"use client";

/**
 * /mcp/authorize — OAuth 2.1 consent screen for MCP clients.
 *
 * Better Auth's mcp() plugin redirects here (its `consentPage`) mid-authorize
 * with `client_id`, `scope`, and a `consent_code` in the query. We authenticate
 * the browser against the Better Auth cookie session, show what's connecting,
 * and on an explicit Approve POST to `/api/auth/oauth2/consent`
 * (`{ accept, consent_code }`) — which returns a `redirectURI` that continues
 * the flow back to the client.
 *
 * Lives top-level (not under (auth)) because it's for an AUTHENTICATED visitor;
 * we wrap AuthShell manually for visual parity with /login and /cloud-authorize.
 */

import { Suspense, useCallback, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, Boxes, AlertCircle, Lock } from "lucide-react";
import { authClient, useSession } from "@/lib/auth-client";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { ResourcePicker } from "@/components/permissions/ResourcePicker";
import { tokensApi, type PickerGrant, type ResourceType } from "@/lib/api";
import { usePlatform } from "@/context/PlatformContext";

function buildReturnTo(searchParams: URLSearchParams): string {
  const qs = searchParams.toString();
  return qs ? `/mcp/authorize?${qs}` : "/mcp/authorize";
}

/** Consent POST → `{ redirectURI }`. Uses the auth client so the cookie session
 *  + auth base URL are handled for us. */
async function postConsent(accept: boolean, consentCode: string | null): Promise<string | null> {
  const res = await (authClient as unknown as {
    $fetch: (
      path: string,
      opts: { method: string; body: Record<string, unknown> },
    ) => Promise<{ data?: { redirectURI?: string } | null; error?: { status?: number } | null }>;
  }).$fetch("/oauth2/consent", {
    method: "POST",
    body: { accept, ...(consentCode ? { consent_code: consentCode } : {}) },
  });
  if (res.error) {
    const status = res.error.status;
    throw Object.assign(new Error("consent failed"), { status });
  }
  return res.data?.redirectURI ?? null;
}

function McpAuthorizeInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session, isPending } = useSession();

  const { selfHosted } = usePlatform();

  const clientId = searchParams.get("client_id");
  const scope = searchParams.get("scope") ?? "";
  const consentCode = searchParams.get("consent_code");
  const scopes = useMemo(() => scope.split(/[\s+]+/).filter(Boolean), [scope]);

  const [submitting, setSubmitting] = useState<null | "accept" | "deny">(null);
  const [error, setError] = useState<string | null>(null);

  // What this client may do, chosen here and enforced through the same scoped
  // grant model as a PAT. Read-only blocks writes; picking resources limits the
  // client to exactly those (leave empty → it acts with your full access).
  const [readOnly, setReadOnly] = useState(true);
  const [grants, setGrants] = useState<PickerGrant[]>([]);
  const availableTypes: ResourceType[] = selfHosted
    ? ["project", "server", "mail_server", "backup_destination", "audit", "github_installation", "github_repository"]
    : ["project", "backup_destination", "billing", "audit", "github_installation", "github_repository"];

  const act = useCallback(
    async (accept: boolean) => {
      setError(null);
      setSubmitting(accept ? "accept" : "deny");
      try {
        // Record the client's scope BEFORE issuing a token, so the binding
        // exists when the OAuth token first authenticates. Skip on deny.
        if (accept && clientId) {
          await tokensApi.mcpAuthorize({ clientId, readOnly, grants });
        }
        const redirectURI = await postConsent(accept, consentCode);
        if (redirectURI) {
          window.location.href = redirectURI; // continue the OAuth flow
          return;
        }
        // No redirect (e.g. denied with no return) — send the user home.
        router.replace("/");
      } catch (err) {
        if ((err as { status?: number }).status === 401) {
          router.replace(`/login?returnTo=${encodeURIComponent(buildReturnTo(new URLSearchParams(searchParams.toString())))}`);
          return;
        }
        setError("Couldn't complete authorization. Please try again.");
        setSubmitting(null);
      }
    },
    [clientId, readOnly, grants, consentCode, router, searchParams],
  );

  // Not signed in → bounce to login, returning here afterward.
  if (!isPending && !session) {
    router.replace(`/login?returnTo=${encodeURIComponent(buildReturnTo(new URLSearchParams(searchParams.toString())))}`);
    return null;
  }

  if (isPending) {
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  if (!clientId) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/[0.06] p-4 text-sm text-red-500">
        <AlertCircle className="mt-0.5 size-4 shrink-0" />
        Missing client_id — this authorization link is invalid.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex size-11 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-500">
          <Boxes className="size-5" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-foreground">Authorize MCP client</h1>
          <p className="text-sm text-muted-foreground">
            An MCP client wants to connect to your Openship account.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-border/50 bg-muted/20 p-4 text-sm">
        <p className="text-muted-foreground">
          Signed in as <span className="font-medium text-foreground">{session?.user?.email}</span>
        </p>
        <p className="mt-2 text-muted-foreground">
          Client <span className="font-mono text-xs text-foreground">{clientId}</span>
        </p>
        {scopes.length > 0 && (
          <div className="mt-3">
            <p className="text-xs font-medium text-foreground">Requested access</p>
            <ul className="mt-1 space-y-1">
              {scopes.map((s) => (
                <li key={s} className="font-mono text-xs text-muted-foreground">{s}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Scope — enforced through the same grant model as a Personal Access
          Token. Read-only + optional per-resource limits. */}
      <div className="space-y-3 rounded-xl border border-border/50 p-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">What this client can access</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            You can only grant access you hold yourself. Leave resources empty to grant your full access.
          </p>
        </div>

        <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={readOnly}
            onChange={(e) => setReadOnly(e.target.checked)}
            disabled={submitting !== null}
            className="size-4 rounded border-border/60"
          />
          <Lock className="size-3.5 text-muted-foreground" />
          Read-only (blocks all writes)
        </label>

        <div className="space-y-2">
          <p className="text-xs font-medium text-foreground">
            Limit to specific resources{" "}
            <span className="font-normal text-muted-foreground">
              ({grants.length > 0 ? `${grants.length} selected` : "optional"})
            </span>
          </p>
          <ResourcePicker
            value={grants}
            onChange={setGrants}
            availableTypes={availableTypes}
            defaultPermissions={["read"]}
            disabled={submitting !== null}
          />
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/[0.06] p-3 text-sm text-red-500">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" disabled={submitting !== null} onClick={() => act(false)}>
          {submitting === "deny" ? <Loader2 className="size-4 animate-spin" /> : "Deny"}
        </Button>
        <Button disabled={submitting !== null} onClick={() => act(true)}>
          {submitting === "accept" ? <Loader2 className="size-4 animate-spin" /> : "Authorize"}
        </Button>
      </div>
    </div>
  );
}

export default function McpAuthorizePage() {
  return (
    <AuthShell>
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        }
      >
        <McpAuthorizeInner />
      </Suspense>
    </AuthShell>
  );
}
