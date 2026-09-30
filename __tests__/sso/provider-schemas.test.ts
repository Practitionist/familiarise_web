/**
 * Guards against regressions in the SSO provider POST schema. SSO is
 * OIDC-only, so anything other than an OIDC registration must be refused.
 */

import fs from "node:fs";
import path from "node:path";
import {
  createProviderSchema,
  generateProviderId,
  isReservedProviderId,
  oidcConfigSchema,
  RESERVED_PROVIDER_IDS,
} from "@/lib/sso/provider-schemas";

const OIDC_CONFIG = {
  issuer: "https://tenant.auth0.com/",
  clientId: "abc123",
  clientSecret: "shh",
  discoveryEndpoint:
    "https://tenant.auth0.com/.well-known/openid-configuration",
};

describe("oidcConfigSchema", () => {
  const valid = {
    issuer: "https://tenant.auth0.com/",
    clientId: "abc123",
    clientSecret: "shh",
    discoveryEndpoint:
      "https://tenant.auth0.com/.well-known/openid-configuration",
    pkce: true,
  };

  test("accepts a full OIDC config", () => {
    expect(oidcConfigSchema.safeParse(valid).success).toBe(true);
  });

  test("pkce defaults to true when omitted — required to prevent the raw-fetch regression", () => {
    const { pkce, ...rest } = valid;
    void pkce;
    expect(oidcConfigSchema.parse(rest).pkce).toBe(true);
  });
});

describe("createProviderSchema", () => {
  test("accepts a minimal OIDC registration", () => {
    const result = createProviderSchema.safeParse({
      domain: "acme.com",
      issuer: "https://tenant.auth0.com/",
      providerType: "oidc",
      oidcConfig: OIDC_CONFIG,
    });
    expect(result.success).toBe(true);
  });

  test("drops a client-supplied providerId — the server generates it", () => {
    const result = createProviderSchema.safeParse({
      providerId: "google",
      domain: "acme.com",
      issuer: "https://tenant.auth0.com/",
      providerType: "oidc",
      oidcConfig: OIDC_CONFIG,
    });
    expect(result.success).toBe(true);
    expect(result.success && "providerId" in result.data).toBe(false);
  });

  test("providerType must be oidc", () => {
    const result = createProviderSchema.safeParse({
      domain: "acme.com",
      issuer: "https://idp.acme.com",
      providerType: "saml",
      oidcConfig: OIDC_CONFIG,
    });
    expect(result.success).toBe(false);
  });

  test("oidcConfig is required", () => {
    const result = createProviderSchema.safeParse({
      domain: "acme.com",
      issuer: "https://tenant.auth0.com/",
      providerType: "oidc",
    });
    expect(result.success).toBe(false);
  });
});

describe("generateProviderId", () => {
  test("is URL-safe, unique and never reserved", () => {
    const ids = new Set(Array.from({ length: 50 }, generateProviderId));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(/^oidc-[0-9a-f]{16}$/);
      expect(isReservedProviderId(id)).toBe(false);
    }
  });
});

describe("sso_provider_id_not_reserved", () => {
  test("the DB CHECK lists exactly RESERVED_PROVIDER_IDS", () => {
    const sql = fs.readFileSync(
      path.join(process.cwd(), "prisma/sql/check-constraints.sql"),
      "utf8",
    );
    const match =
      /"sso_provider_id_not_reserved"\s+CHECK \(lower\(btrim\("providerId"\)\) NOT IN \(([^)]*)\)\)/.exec(
        sql,
      );
    expect(match).not.toBeNull();
    const inSql = [...(match?.[1] ?? "").matchAll(/'([^']+)'/g)].map(
      (m) => m[1],
    );
    expect([...inSql].sort()).toEqual([...RESERVED_PROVIDER_IDS].sort());
  });
});
