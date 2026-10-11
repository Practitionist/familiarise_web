/**
 * Guards against regressions in the IdP-setup URL surfaced in the Add
 * Provider dialog. If BetterAuth's default endpoint template ever drifts
 * from this, the redirect URI we hand to IT admins would no longer match
 * the callback BetterAuth actually mounts, and OIDC callbacks would be
 * rejected silently.
 */

import { deriveCallbackUrl } from "@/lib/sso/derive-urls";

const BASE = "http://localhost:3000";

describe("deriveCallbackUrl", () => {
  test("uses the /callback/{providerId} endpoint", () => {
    expect(deriveCallbackUrl("acme-auth0", BASE)).toBe(
      "http://localhost:3000/api/auth/sso/callback/acme-auth0",
    );
  });

  test("empty providerId substitutes a placeholder (empty form state)", () => {
    expect(deriveCallbackUrl("", BASE)).toBe(
      "http://localhost:3000/api/auth/sso/callback/<provider-id>",
    );
  });

  test("baseUrl is injected verbatim (no trailing-slash normalisation)", () => {
    expect(deriveCallbackUrl("x", "https://app.prod.example.com")).toBe(
      "https://app.prod.example.com/api/auth/sso/callback/x",
    );
  });
});
