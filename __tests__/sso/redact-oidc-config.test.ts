/**
 * The provider detail GET returns the stored OIDC config through
 * `redactOidcConfig`; the client secret must never come back.
 */

import { redactOidcConfig } from "@/lib/sso/redact-oidc-config";

describe("redactOidcConfig", () => {
  test("drops clientSecret and every unlisted field, reports the secret as set", () => {
    const redacted = redactOidcConfig({
      issuer: "https://idp.acme.com",
      clientId: "abc123",
      clientSecret: "shh",
      discoveryEndpoint:
        "https://idp.acme.com/.well-known/openid-configuration",
      tokenEndpoint: "https://idp.acme.com/token",
      privateKey: "-----BEGIN PRIVATE KEY-----",
      scopes: ["openid", "email"],
      pkce: true,
    });

    expect(redacted).toEqual({
      issuer: "https://idp.acme.com",
      clientId: "abc123",
      discoveryEndpoint:
        "https://idp.acme.com/.well-known/openid-configuration",
      scopes: ["openid", "email"],
      pkce: true,
      hasClientSecret: true,
    });
    expect(JSON.stringify(redacted)).not.toContain("shh");
  });

  test("a missing config stays null and a missing secret reads as unset", () => {
    expect(redactOidcConfig(null)).toBeNull();
    expect(redactOidcConfig({ issuer: "x" })).toMatchObject({
      hasClientSecret: false,
    });
  });
});
