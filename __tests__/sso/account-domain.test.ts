/**
 * @jest-environment node
 */

const findUnique = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    ssoProvider: { findUnique: (...a: unknown[]) => findUnique(...a) },
  },
}));

import {
  assertSsoEmailOnDomain,
  isSsoProviderId,
} from "../../lib/sso/account-domain";

const approved = { domain: "Acme.test", domainVerified: true };

beforeEach(() => findUnique.mockReset());

it("accepts an email on an approved provider's domain, case-insensitively", async () => {
  findUnique.mockResolvedValue(approved);
  await expect(
    assertSsoEmailOnDomain("oidc-acme", "Asha@ACME.test"),
  ).resolves.toBeUndefined();
});

it.each([
  ["another domain", approved, "victim@gmail.test"],
  ["a subdomain", approved, "asha@eu.acme.test"],
  [
    "an unapproved provider",
    { ...approved, domainVerified: false },
    "a@acme.test",
  ],
  ["an unknown provider", null, "a@acme.test"],
])("refuses %s", async (_label, provider, email) => {
  findUnique.mockResolvedValue(provider);
  await expect(
    assertSsoEmailOnDomain("oidc-acme", email),
  ).rejects.toMatchObject({ body: { code: "SSO_EMAIL_DOMAIN_MISMATCH" } });
});

it("refuses without a provider id or an email", async () => {
  await expect(
    assertSsoEmailOnDomain(undefined, "a@acme.test"),
  ).rejects.toThrow();
  await expect(assertSsoEmailOnDomain("oidc-acme", null)).rejects.toThrow();
  expect(findUnique).not.toHaveBeenCalled();
});

it("treats only credential and the social providers as non-SSO", () => {
  expect(isSsoProviderId("credential")).toBe(false);
  expect(isSsoProviderId("google")).toBe(false);
  expect(isSsoProviderId("github")).toBe(false);
  expect(isSsoProviderId("oidc-acme")).toBe(true);
});
