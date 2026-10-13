/**
 * @jest-environment node
 */

/** D22 — the org detail carries each SSO provider's approval inputs. */

const mockPrisma = {
  organization: { findUnique: jest.fn() },
  ssoProvider: { findMany: jest.fn() },
  orgDomainClaim: { findMany: jest.fn() },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockPrisma;
  },
}));
jest.mock("../../lib/payments/wallet-freeze", () => ({
  isWalletFrozen: jest.fn(async () => false),
}));

import { readOrgDetail } from "@/lib/backoffice/org-detail";

it("marks whether the org still holds a verified claim for each provider's domain", async () => {
  mockPrisma.organization.findUnique.mockResolvedValue({
    id: "org_1",
    billingAccount: null,
  });
  mockPrisma.ssoProvider.findMany.mockResolvedValue([
    {
      providerId: "oidc-a",
      issuer: "i",
      domain: "acme.com",
      domainVerified: true,
    },
    {
      providerId: "oidc-b",
      issuer: "i",
      domain: "acme.org",
      domainVerified: false,
    },
  ]);
  mockPrisma.orgDomainClaim.findMany.mockResolvedValue([
    { domain: "acme.com" },
  ]);

  const org = await readOrgDetail("org_1");

  expect(mockPrisma.orgDomainClaim.findMany).toHaveBeenCalledWith({
    where: { organizationId: "org_1", verifiedAt: { not: null } },
    select: { domain: true },
  });
  expect(org?.ssoProviders.map((p) => [p.providerId, p.claimVerified])).toEqual(
    [
      ["oidc-a", true],
      ["oidc-b", false],
    ],
  );
});
