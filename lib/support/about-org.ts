import type { MemberRole } from "@prisma/client";

import { hasOrgPermission } from "@/lib/auth/org-permissions";

/**
 * #1527 — a new support request may be "About" an org only where the viewer
 * is ACTIVE and reads that org's support requests (operations.read OR
 * billing.read). The form offers these; the create route re-checks them.
 */
export function canRaiseAboutOrg(membership: {
  role: MemberRole | string;
  status: string;
}): boolean {
  return (
    membership.status === "ACTIVE" &&
    hasOrgPermission(membership.role as MemberRole, "supportRequests.org")
  );
}
