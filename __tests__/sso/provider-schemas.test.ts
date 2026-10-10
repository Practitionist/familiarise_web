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
  updateProviderSchema,
} from "@/lib/sso/provider-schemas";

const OIDC_CONFIG = {
  clientId: "abc123",
  clientSecret: "shh",
  discoveryEndpoint:
    "https://tenant.auth0.com/.well-known/openid-configuration",
};

describe("oidcConfigSchema", () => {
  test("accepts a full OIDC config", () => {
    expect(oidcConfigSchema.safeParse(OIDC_CONFIG).success).toBe(true);
  });

  test("strips client-chosen pkce, scopes and issuer: the server fixes them", () => {
    const parsed = oidcConfigSchema.parse({
      ...OIDC_CONFIG,
      pkce: false,
      scopes: ["profile"],
      issuer: "https://elsewhere",
    });
    expect(parsed).toEqual(OIDC_CONFIG);
  });
});

describe("createProviderSchema", () => {
  const base = {
    domains: ["Acme.com", "acme.co.in"],
    issuer: "https://tenant.auth0.com/",
    providerType: "oidc",
    oidcConfig: OIDC_CONFIG,
  };

  test("accepts a multi-domain OIDC registration, lowercasing domains", () => {
    const result = createProviderSchema.safeParse(base);
    expect(result.success && result.data.domains).toEqual([
      "acme.com",
      "acme.co.in",
    ]);
  });

  test.each([[[]], [["https://acme.com"]], [["acme"]]])(
    "refuses domains %j",
    (domains) => {
      expect(createProviderSchema.safeParse({ ...base, domains }).success).toBe(
        false,
      );
    },
  );

  test("drops a client-supplied providerId — the server generates it", () => {
    const result = createProviderSchema.safeParse({
      ...base,
      providerId: "google",
    });
    expect(result.success).toBe(true);
    expect(result.success && "providerId" in result.data).toBe(false);
  });

  test("providerType must be oidc", () => {
    expect(
      createProviderSchema.safeParse({ ...base, providerType: "saml" }).success,
    ).toBe(false);
  });

  test("oidcConfig is required", () => {
    const { oidcConfig: _omit, ...rest } = base;
    void _omit;
    expect(createProviderSchema.safeParse(rest).success).toBe(false);
  });
});

describe("updateProviderSchema", () => {
  test("needs a secret, domains or both", () => {
    expect(updateProviderSchema.safeParse({}).success).toBe(false);
    expect(updateProviderSchema.safeParse({ clientSecret: "x" }).success).toBe(
      true,
    );
    expect(
      updateProviderSchema.safeParse({ domains: ["acme.com"] }).success,
    ).toBe(true);
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
