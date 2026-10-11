/**
 * @jest-environment node
 */

const findUnique = jest.fn();
const claimFindFirst = jest.fn();
const accountFindFirst = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    ssoProvider: { findUnique: (...a: unknown[]) => findUnique(...a) },
    orgDomainClaim: { findFirst: (...a: unknown[]) => claimFindFirst(...a) },
    account: { findFirst: (...a: unknown[]) => accountFindFirst(...a) },
  },
}));
const recordSsoRefusal = jest.fn();
jest.mock("../../lib/sso/refusal-audit", () => ({
  recordSsoRefusal: (...a: unknown[]) => recordSsoRefusal(...a),
}));

import {
  assertSsoAccountLink,
  assertSsoEmailOnDomain,
  isSsoProviderId,
} from "../../lib/sso/account-domain";

const approved = {
  domain: "Acme.test",
  domainVerified: true,
  organizationId: "org_1",
};

beforeEach(() => {
  findUnique.mockReset();
  claimFindFirst.mockReset().mockResolvedValue({ id: "claim_1" });
  accountFindFirst.mockReset().mockResolvedValue(null);
  recordSsoRefusal.mockReset();
});

it("accepts an email on an approved provider's domain, case-insensitively", async () => {
  findUnique.mockResolvedValue(approved);
  await expect(
    assertSsoEmailOnDomain("oidc-acme", "Asha@ACME.test"),
  ).resolves.toBeUndefined();
  expect(claimFindFirst).toHaveBeenCalledWith({
    where: {
      organizationId: "org_1",
      domain: "acme.test",
      verifiedAt: { not: null },
    },
    select: { id: true },
  });
});

it("accepts every domain of a multi-domain provider", async () => {
  findUnique.mockResolvedValue({ ...approved, domain: "acme.co.in,acme.test" });
  await expect(
    assertSsoEmailOnDomain("oidc-acme", "asha@acme.co.in"),
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

it("refuses a covered domain whose claim is no longer verified, and audits it", async () => {
  findUnique.mockResolvedValue(approved);
  claimFindFirst.mockResolvedValue(null);
  await expect(
    assertSsoEmailOnDomain("oidc-acme", "asha@acme.test"),
  ).rejects.toMatchObject({ body: { code: "SSO_EMAIL_DOMAIN_MISMATCH" } });
  expect(recordSsoRefusal).toHaveBeenCalledWith({
    organizationId: "org_1",
    code: "SSO_EMAIL_DOMAIN_MISMATCH",
    email: "asha@acme.test",
  });
});

it("refuses without a provider id or an email", async () => {
  await expect(
    assertSsoEmailOnDomain(undefined, "a@acme.test"),
  ).rejects.toThrow();
  await expect(assertSsoEmailOnDomain("oidc-acme", null)).rejects.toThrow();
  expect(findUnique).not.toHaveBeenCalled();
});

describe("assertSsoAccountLink", () => {
  const account = {
    userId: "u_1",
    providerId: "oidc-acme",
    accountId: "sub-2",
  };

  it("links the first identity from a provider", async () => {
    findUnique.mockResolvedValue(approved);
    await expect(
      assertSsoAccountLink(account, "asha@acme.test"),
    ).resolves.toBeUndefined();
    expect(accountFindFirst).toHaveBeenCalledWith({
      where: {
        userId: "u_1",
        providerId: "oidc-acme",
        accountId: { not: "sub-2" },
      },
      select: { id: true },
    });
  });

  it("refuses a second identity from the same provider for one user", async () => {
    findUnique.mockResolvedValue(approved);
    accountFindFirst.mockResolvedValue({ id: "acc_1" });
    await expect(
      assertSsoAccountLink(account, "asha@acme.test"),
    ).rejects.toMatchObject({ body: { code: "SSO_ACCOUNT_ALREADY_LINKED" } });
  });
});

it("treats only credential and the social providers as non-SSO", () => {
  expect(isSsoProviderId("credential")).toBe(false);
  expect(isSsoProviderId("google")).toBe(false);
  expect(isSsoProviderId("github")).toBe(false);
  expect(isSsoProviderId("oidc-acme")).toBe(true);
});
