import prisma, { type Tx } from "@/lib/prisma";
import type { MemberRole } from "@prisma/client";

import { hasOrgPermission, type OrgSurface } from "@/lib/auth/org-permissions";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

/** What the funding org may do to one of its bookings as the payer. */
export type OrgActorAction = "reschedule" | "cancel";

// #1527 decision 8 — MANAGER may reschedule an org-funded booking; cancel
// refunds, so it stays OWNER/MAINTAINER. The matrix is the single source.
const ACTION_GRANT: Record<OrgActorAction, OrgSurface> = {
  reschedule: "appointments.actForOrg.reschedule",
  cancel: "appointments.actForOrg.cancel",
};

/**
 * The booking facts the act-for-org verbs read. `organizationId` is the org
 * stamped at checkout for an org-context booking; the two plan ids tell a
 * 1:1 or subscription booking from a group session.
 */
export interface OrgActorTarget {
  organizationId: string | null | undefined;
  consultationId?: string | null;
  subscriptionId?: string | null;
}

/** The ACTIVE membership acting for the org, as recorded in the audit row. */
export interface OrgActor {
  organizationId: string;
  membershipId: string;
}

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
 * #1851 decision 1 — only 1:1 and subscription bookings the org funds. An
 * org-hosted webinar or class carries the HOST org's id, and moving or
 * cancelling one changes every attendee's seat, so the host does that from
 * Catalog as a whole session, never through act-for-org.
 */
export function isActForOrgBooking(target: OrgActorTarget): boolean {
  return (
    !!target.organizationId &&
    (!!target.consultationId || !!target.subscriptionId)
  );
}

/**
 * #1166 ORG-9 half — lifecycle authorization for the org that funds a booking.
 * An ACTIVE member holding the action's grant may act on the PAYER side of the
 * policy tiers (never the consultant side). Returns the acting membership so
 * the caller can write the audit row, or null when the caller may not act.
 */
export async function resolveOrgActor(
  userId: string,
  target: OrgActorTarget,
  action: OrgActorAction,
): Promise<OrgActor | null> {
  if (!isActForOrgBooking(target) || !target.organizationId) return null;
  const organizationId = target.organizationId;
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId } },
    select: { id: true, status: true, role: true },
  });
  if (
    membership?.status !== "ACTIVE" ||
    !canActForOrg(membership.role, action)
  ) {
    return null;
  }
  return { organizationId, membershipId: membership.id };
}

export async function isOrgAdminOfAppointment(
  userId: string,
  target: OrgActorTarget,
  action: OrgActorAction,
): Promise<boolean> {
  return (await resolveOrgActor(userId, target, action)) !== null;
}

/**
 * #1851 decision 2 — every act-for-org verb leaves an OrgAuditLog row next to
 * the booking's own history. It rides the MEMBER category (the booking is a
 * member's record, and SUPPORT reads that category) as its own action, so no
 * schema change is needed. Written on the caller's transaction so the row
 * exists exactly when the booking change does. `details` carries no amounts:
 * the refund, if any, is audited on the money side.
 */
export async function recordActForOrg(
  tx: Pick<Tx, "orgAuditLog">,
  input: {
    actor: OrgActor;
    action: OrgActorAction;
    appointmentId: string;
    reason?: string | null;
  },
): Promise<void> {
  const { actor, action, appointmentId, reason } = input;
  await tx.orgAuditLog.create({
    data: {
      organizationId: actor.organizationId,
      actorMembershipId: actor.membershipId,
      category: "MEMBER",
      action:
        action === "cancel"
          ? AUDIT_ACTIONS.MEMBER.APPOINTMENT_CANCELLED_FOR_ORG
          : AUDIT_ACTIONS.MEMBER.APPOINTMENT_RESCHEDULE_REQUESTED_FOR_ORG,
      description:
        action === "cancel"
          ? "Cancelled a booking for the organization"
          : "Asked to reschedule a booking for the organization",
      details: { appointmentId, reason: reason ?? null },
    },
  });
}
