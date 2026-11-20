import type { MemberRole, Prisma } from "@prisma/client";

import { hasOrgPermission } from "@/lib/auth/org-permissions";

/** A draft invoice is visible only to a role that manages billing. */
export function canSeeDraftInvoices(role: MemberRole): boolean {
  return hasOrgPermission(role, "billing.manage");
}

/**
 * The organisation invoices `role` may read: every one for a billing manager,
 * all but drafts for everyone else. The list, detail, PDF and CSV export all
 * filter through it.
 */
export function visibleInvoiceWhere(
  role: MemberRole,
): Prisma.OrganizationInvoiceWhereInput {
  return canSeeDraftInvoices(role) ? {} : { status: { not: "DRAFT" } };
}
