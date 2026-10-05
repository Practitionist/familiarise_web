import type { MemberRole } from "@prisma/client";

import { hasOrgPermission } from "@/lib/auth/org-permissions";

/**
 * The org-details Prisma include, in a LEAF module (its one import is the
 * dependency-free permission matrix).
 *
 * It lives apart from lib/data/org-details-server.ts on purpose. That module
 * imports requireOrgAccess (and therefore the whole auth-helpers graph), and
 * pulling it into GET /api/organizations/[orgId] made that route 500 on every
 * request — verified by A/B against a preview without the change: 200 3/3
 * there, 500 3/3 with it. The route only ever needed the shape, so the shape
 * ships on its own and the heavy read stays where it belongs.
 */
export const orgDetailsInclude = {
  brandingProfile: { select: { logo: true, bannerImage: true } },
  billingAccount: {
    select: {
      id: true,
      fundingSource: true,
      currency: true,
      walletBalance: true,
      creditLimit: true,
    },
  },
  payoutAccount: {
    select: {
      id: true,
      status: true,
      accountNumberLast4: true,
      bankName: true,
    },
  },
  // #1230 — settings UI renders the MSME declaration; the payout deadline
  // engine already reads this satellite server-side.
  msmeInfo: { select: { msmeStatus: true, msmeWrittenAgreementOnFile: true } },
  _count: {
    select: {
      memberships: true,
      contracts: true,
      invoices: true,
      purchaseOrders: true,
      auditLogs: true,
    },
  },
} as const;

type OrgMoneyShape = {
  billingAccount: { walletBalance: unknown; creditLimit: unknown } | null;
  payoutAccount: { accountNumberLast4: unknown; bankName: unknown } | null;
};
type NullFields<T, K extends PropertyKey> = T extends null
  ? null
  : Omit<T, K & keyof T> & { [P in K & keyof T]: T[P] | null };

/** The org-details row as served — money fields nullable after redaction. */
export type RedactedOrgDetails<T extends OrgMoneyShape> = Omit<
  T,
  "billingAccount" | "payoutAccount"
> & {
  billingAccount: NullFields<
    T["billingAccount"],
    "walletBalance" | "creditLimit"
  >;
  payoutAccount: NullFields<
    T["payoutAccount"],
    "accountNumberLast4" | "bankName"
  >;
};

/**
 * #1527 P0-1 — this payload is pre-loaded into every org page for every
 * member, so money fields go only to roles whose Billing / Payouts surface
 * already shows them. `fundingSource` and `currency` stay: nav and booking
 * copy need them.
 */
export function redactOrgDetailsForRole<T extends OrgMoneyShape>(
  org: T,
  role: MemberRole,
): RedactedOrgDetails<T> {
  const billingAccount =
    org.billingAccount && !hasOrgPermission(role, "billing.read")
      ? { ...org.billingAccount, walletBalance: null, creditLimit: null }
      : org.billingAccount;
  const payoutAccount =
    org.payoutAccount && !hasOrgPermission(role, "payouts.read")
      ? { ...org.payoutAccount, accountNumberLast4: null, bankName: null }
      : org.payoutAccount;
  // Spreads over a generic row can't be narrowed field-by-field by tsc.
  return {
    ...org,
    billingAccount,
    payoutAccount,
  } as unknown as RedactedOrgDetails<T>;
}

/**
 * #1527 decision 6 — a SUSPENDED member reads only what the org shell needs
 * to render Appointments › Mine: identity, capabilities and funding source.
 * No org profile scalars, counts, money or payout fields.
 */
export function suspendedOrgDetails(org: {
  id: string;
  name: string;
  slug: string;
  status: string;
  canSponsor: boolean;
  canHost: boolean;
  requiresPO: boolean;
  brandingProfile: { logo: string | null } | null;
  billingAccount: { fundingSource: unknown } | null;
}) {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    status: org.status,
    canSponsor: org.canSponsor,
    canHost: org.canHost,
    requiresPO: org.requiresPO,
    brandingProfile: org.brandingProfile,
    billingAccount: org.billingAccount
      ? { fundingSource: org.billingAccount.fundingSource }
      : null,
  };
}
