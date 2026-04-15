/**
 * Guards against regressions in the SSO provider POST schema.
 *
 * The most important invariant: `samlConfig` must NOT accept a `callbackUrl`.
 * BetterAuth auto-derives the ACS URL; letting admins type a custom value is
 * a footgun that silently breaks SAML when it drifts from BetterAuth's
 * derived endpoint. See issue #672 Gap 6 for history.
 */

import {
  createProviderSchema,
  samlConfigSchema,
  oidcConfigSchema,
} from "@/lib/sso/provider-schemas";

describe("samlConfigSchema", () => {
  const valid = {
    issuer: "https://idp.acme.com",
    entryPoint: "https://idp.acme.com/sso/saml",
    cert: "-----BEGIN CERTIFICATE-----\nMIIC...\n-----END CERTIFICATE-----",
  };

  test("accepts minimal valid SAML config", () => {
    expect(samlConfigSchema.safeParse(valid).success).toBe(true);
  });

  test("strips unknown keys including the forbidden callbackUrl", () => {
    const withCallback = {
      ...valid,
      callbackUrl: "https://attacker.example.com/evil",
    };
    const result = samlConfigSchema.safeParse(withCallback);
    // The schema is permissive of unknown keys but must NOT expose them
    // downstream. If `callbackUrl` ever becomes part of the typed output,
    // BetterAuth will honour it and override the derived ACS URL.
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("callbackUrl");
    }
  });

  test("rejects a non-URL entryPoint", () => {
    const result = samlConfigSchema.safeParse({ ...valid, entryPoint: "not-a-url" });
    expect(result.success).toBe(false);
  });

  test("rejects an empty cert", () => {
    const result = samlConfigSchema.safeParse({ ...valid, cert: "" });
    expect(result.success).toBe(false);
  });
});

describe("oidcConfigSchema", () => {
  const valid = {
    issuer: "https://tenant.auth0.com/",
    clientId: "abc123",
    clientSecret: "shh",
    discoveryEndpoint: "https://tenant.auth0.com/.well-known/openid-configuration",
    pkce: true,
  };

  test("accepts a full OIDC config", () => {
    expect(oidcConfigSchema.safeParse(valid).success).toBe(true);
  });

  test("pkce defaults to true when omitted — required to prevent the raw-fetch regression", () => {
    const { pkce, ...rest } = valid;
    void pkce;
    const result = oidcConfigSchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pkce).toBe(true);
    }
  });
});

describe("createProviderSchema", () => {
  test("rejects non-alphanumeric providerId (prevents path-injection in auto-derived URLs)", () => {
    const result = createProviderSchema.safeParse({
      providerId: "../admin",
      domain: "acme.com",
      issuer: "https://idp.acme.com",
      providerType: "saml",
      samlConfig: {
        issuer: "https://idp.acme.com",
        entryPoint: "https://idp.acme.com/sso",
        cert: "cert",
      },
    });
    expect(result.success).toBe(false);
  });

  test("providerType must be saml or oidc", () => {
    const result = createProviderSchema.safeParse({
      providerId: "x",
      domain: "acme.com",
      issuer: "https://idp.acme.com",
      providerType: "ldap",
    });
    expect(result.success).toBe(false);
  });
});
