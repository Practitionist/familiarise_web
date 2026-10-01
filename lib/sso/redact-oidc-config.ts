/**
 * The stored OIDC config minus its secret. Fields are picked, not deleted,
 * so a secret-bearing field added to the stored shape later stays hidden
 * until someone deliberately lists it here. `hasClientSecret` lets the page
 * show that one is set.
 */
export function redactOidcConfig(config: unknown) {
  if (!config || typeof config !== "object") return null;
  const c = config as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    issuer: str(c.issuer),
    clientId: str(c.clientId),
    discoveryEndpoint: str(c.discoveryEndpoint),
    scopes: Array.isArray(c.scopes)
      ? c.scopes.filter((x): x is string => typeof x === "string")
      : null,
    pkce: typeof c.pkce === "boolean" ? c.pkce : null,
    hasClientSecret:
      typeof c.clientSecret === "string" && c.clientSecret.length > 0,
  };
}
