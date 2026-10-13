import prisma from "@/lib/prisma";
import { isWalletFrozen } from "@/lib/payments/wallet-freeze";
import { providerDomains } from "@/lib/sso/domains";

/**
 * #1527 — the back-office org detail: identity, KYB/GST satellites, billing
 * account and its wallet-freeze state, and its SSO providers. Sequential reads (PG_POOL_MAX=1).
 */
export async function readOrgDetail(orgId: string) {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      name: true,
      slug: true,
      status: true,
      canSponsor: true,
      canHost: true,
      requiresPO: true,
      paymentTermsDays: true,
      billingEmail: true,
      verificationReason: true,
      verificationSubmittedAt: true,
      verificationRejectedAt: true,
      createdAt: true,
      taxInfo: {
        select: {
          legalName: true,
          gstin: true,
          gstStateCode: true,
          gstRegStatus: true,
          panLast4: true,
        },
      },
      kybVerification: { select: { kybVerifiedAt: true } },
      billingAccount: { select: { id: true, fundingSource: true } },
      ssoSettings: { select: { enforceSSO: true } },
      _count: { select: { memberships: true, contracts: true } },
    },
  });
  if (!org) return null;
  const walletFrozen = org.billingAccount
    ? await isWalletFrozen(prisma, org.billingAccount.id)
    : false;
  // What staff need to approve a provider: whether the org still holds a
  // verified DNS claim for every domain it covers (the approval route re-checks).
  const providers = await prisma.ssoProvider.findMany({
    where: { organizationId: orgId },
    select: {
      providerId: true,
      issuer: true,
      domain: true,
      domainVerified: true,
    },
    orderBy: { providerId: "asc" },
  });
  const verifiedDomains = new Set(
    (
      await prisma.orgDomainClaim.findMany({
        where: { organizationId: orgId, verifiedAt: { not: null } },
        select: { domain: true },
      })
    ).map((c) => c.domain),
  );
  const ssoProviders = providers.map((p) => ({
    ...p,
    claimVerified: providerDomains(p.domain).every((d) =>
      verifiedDomains.has(d),
    ),
  }));
  return { ...org, walletFrozen, ssoProviders };
}

export type OrgDetail = NonNullable<Awaited<ReturnType<typeof readOrgDetail>>>;

/** Providers waiting for staff approval, oldest first, across every org. */
export async function readPendingSsoApprovals() {
  const rows = await prisma.ssoProvider.findMany({
    where: { domainVerified: false, organizationId: { not: null } },
    select: {
      providerId: true,
      issuer: true,
      domain: true,
      createdAt: true,
      organization: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  return rows.flatMap((r) =>
    r.organization
      ? [
          {
            providerId: r.providerId,
            issuer: r.issuer,
            domains: providerDomains(r.domain),
            submittedAt: r.createdAt.toISOString(),
            orgId: r.organization.id,
            orgName: r.organization.name,
          },
        ]
      : [],
  );
}

export type PendingSsoApproval = Awaited<
  ReturnType<typeof readPendingSsoApprovals>
>[number];
