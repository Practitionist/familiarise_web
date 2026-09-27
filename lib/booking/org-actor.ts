import prisma from "@/lib/prisma";
import type { MemberRole } from "@prisma/client";

import { hasOrgPermission, type OrgSurface } from "@/lib/auth/org-permissions";

/** What the funding org may do to one of its bookings as the payer. */
export type OrgActorAction = "reschedule" | "cancel";

// #1527 decision 8 — MANAGER may reschedule an org-funded booking; cancel
// refunds, so it stays OWNER/MAINTAINER. The matrix is the single source.
const ACTION_GRANT: Record<OrgActorAction, OrgSurface> = {
  reschedule: "appointments.actForOrg.reschedule",
  cancel: "appointments.actForOrg.cancel",
};

/**
 * The payer-side actor for an org-funded booking. EXPERT and the other member
 * roles are deliberately excluded. Named separately from the lookup below
 * because surfaces that already hold a resolved Membership (the org dashboard
 * pages) need the rule without a second round trip.
 */
export function canActForOrg(
  role: MemberRole | null | undefined,
  action: OrgActorAction,
): boolean {
  return !!role && hasOrgPermission(role, ACTION_GRANT[action]);
}

/**
 * #1166 ORG-9 half — lifecycle authorization for the org that funds a booking.
 * An ACTIVE member holding the action's grant may act on the PAYER side of the
 * policy tiers (never the consultant side).
 */
export async function isOrgAdminOfAppointment(
  userId: string,
  organizationId: string | null | undefined,
  action: OrgActorAction,
): Promise<boolean> {
  if (!organizationId) return false;
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId } },
    select: { status: true, role: true },
  });
  return (
    membership?.status === "ACTIVE" && canActForOrg(membership.role, action)
  );
}
