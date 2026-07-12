import { api } from "./client";
import { endpoints } from "./endpoints";
import type { PickerGrant } from "./permissions";

export interface AccessToken {
  id: string;
  name: string;
  tokenPrefix: string;
  readOnly: boolean;
  /** True when the token is limited to specific resources (its own grants). */
  scoped: boolean;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** Returned only from create — carries the one-time plaintext `token`. */
export interface CreatedAccessToken extends AccessToken {
  token: string;
}

export const tokensApi = {
  list: () => api.get<{ data: AccessToken[] }>(endpoints.tokens.list),
  create: (body: {
    name: string;
    readOnly?: boolean;
    expiresInDays?: number;
    /** Non-empty → a scoped token limited to exactly these resources. */
    grants?: PickerGrant[];
  }) => api.post<{ data: CreatedAccessToken }>(endpoints.tokens.list, body),
  revoke: (id: string) => api.delete<{ data: { revoked: boolean } }>(endpoints.tokens.item(id)),
  /** Record an OAuth MCP client's scope (read-only + resource grants) at consent. */
  mcpAuthorize: (body: { clientId: string; readOnly: boolean; grants: PickerGrant[] }) =>
    api.post<{ data: { ok: boolean; scoped: boolean; readOnly: boolean } }>(
      endpoints.tokens.mcpAuthorize,
      body,
    ),
};
