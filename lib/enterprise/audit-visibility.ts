import type { MemberRole, OrgAuditCategory, Prisma } from "@prisma/client";

import { hasOrgPermission } from "@/lib/auth/org-permissions";

import { AUDIT_ACTIONS } from "./audit-actions";

/**
 * #1527 audit split — which OrgAuditLog rows each role may read. Money rows
 * (wallet, invoice, payout, contract terms, the finance webhook integration,
 * and rate-card edits filed under PROGRAM) carry amounts in their
 * descriptions and details, so `audit.read.ops` alone never sees them and
 * `audit.read.money` alone sees only them. The Audit page, its CSV export and
 * the Home activity feed all filter through this one scope.
 */
export const AUDIT_MONEY_CATEGORIES: readonly OrgAuditCategory[] = [
  "CONTRACT",
  "WALLET",
  "INVOICE",
  "PAYOUT",
  "WEBHOOK",
];

const MONEY_ACTIONS_IN_OPS_CATEGORIES: readonly string[] = [
  AUDIT_ACTIONS.PROGRAM.RATE_CARD_BUMPED,
];

const MONEY_ROW: Prisma.OrgAuditLogWhereInput = {
  OR: [
    { category: { in: [...AUDIT_MONEY_CATEGORIES] } },
    { action: { in: [...MONEY_ACTIONS_IN_OPS_CATEGORIES] } },
  ],
};

/**
 * Prisma filter for the rows `role` may read: `{}` for both grants, the
 * money or non-money half for one, `null` when the role reads no audit rows.
 */
export function auditRowScope(
  role: MemberRole,
): Prisma.OrgAuditLogWhereInput | null {
  const ops = hasOrgPermission(role, "audit.read.ops");
  const money = hasOrgPermission(role, "audit.read.money");
  if (ops && money) return {};
  if (money) return MONEY_ROW;
  if (ops) return { NOT: MONEY_ROW };
  return null;
}

/** Category filter options a role can usefully pick on the Audit page. */
export function visibleAuditCategories(
  role: MemberRole,
  all: readonly OrgAuditCategory[],
): OrgAuditCategory[] {
  const ops = hasOrgPermission(role, "audit.read.ops");
  const money = hasOrgPermission(role, "audit.read.money");
  return all.filter((category) =>
    AUDIT_MONEY_CATEGORIES.includes(category) ? money : ops,
  );
}
