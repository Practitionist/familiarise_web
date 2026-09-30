/**
 * Guards against regressions in the SSO provider POST schema. SSO is
 * OIDC-only, so anything other than an OIDC registration must be refused.
 */

import {
  createProviderSchema,
  oidcConfigSchema,
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
      providerId: "acme-auth0",
      domain: "acme.com",
      issuer: "https://tenant.auth0.com/",
      providerType: "oidc",
      oidcConfig: OIDC_CONFIG,
    });
    expect(result.success).toBe(true);
  });

  test("rejects non-alphanumeric providerId (prevents path-injection in auto-derived URLs)", () => {
    const result = createProviderSchema.safeParse({
      providerId: "../admin",
      domain: "acme.com",
      issuer: "https://tenant.auth0.com/",
      providerType: "oidc",
      oidcConfig: OIDC_CONFIG,
    });
    expect(result.success).toBe(false);
  });

  test("providerType must be oidc", () => {
    const result = createProviderSchema.safeParse({
      providerId: "acme-okta",
      domain: "acme.com",
      issuer: "https://idp.acme.com",
      providerType: "saml",
      oidcConfig: OIDC_CONFIG,
    });
    expect(result.success).toBe(false);
  });

  test("oidcConfig is required", () => {
    const result = createProviderSchema.safeParse({
      providerId: "acme-auth0",
      domain: "acme.com",
      issuer: "https://tenant.auth0.com/",
      providerType: "oidc",
    });
    expect(result.success).toBe(false);
  });
});
