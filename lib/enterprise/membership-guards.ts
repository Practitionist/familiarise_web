import type { MemberRole, MemberStatus } from "@prisma/client";
import type { Tx } from "@/lib/prisma";
import { LIVE_PARTICIPANT_STATUSES } from "@/lib/booking/participants";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { isBlockedRoleTransition } from "./role-transitions";

/**
 * #1846 bucket C — the one membership guard. The dashboard PATCH/DELETE, SCIM
 * provisioning and bulk import all ask these functions whether a role or
 * status move is allowed, so the three channels can no longer disagree about
 * who may become what.
 *
 * Every function runs inside the caller's transaction. The last-OWNER count is
 * only race-safe when that transaction is Serializable (N4): two OWNERs
 * demoting each other each read the other's row, and SSI aborts one of them.
 */

export type MembershipGuardCode =
  | "SELF_CHANGE"
  | "ROLE_REQUIRES_OWNER"
  | "ROLE_TRANSITION_BLOCKED"
  | "REMOVE_AND_REINVITE"
  | "NOT_A_CONSULTANT"
  | "EXPERT_REQUIRES_CANHOST"
  | "LEARNER_REQUIRES_CANSPONSOR"
  | "LAST_OWNER"
  | "PENDING_REQUIRES_ACCEPT"
  | "ALREADY_MEMBER"
  | "MEMBER_ERASED"
  | "REMOVED_REQUIRES_REINVITE"
  | "MEMBER_HAS_OBLIGATIONS";

export class MembershipGuardError extends Error {
  constructor(
    readonly code: MembershipGuardCode,
    message: string,
    readonly httpStatus: 400 | 403 | 409,
    readonly counts?: Record<string, number>,
  ) {
    super(message);
    this.name = "MembershipGuardError";
  }
}

/**
 * Who is acting. A dashboard member acts under their own role. SCIM acts on
 * the group mappings an OWNER configured, so it carries OWNER authority, but it
 * is never "self" and never accepts an invitation on anyone's behalf.
 */
export type MembershipActor =
  | { kind: "member"; membershipId: string; role: MemberRole }
  | { kind: "idp" };

export interface GuardedMembership {
  id: string;
  organizationId: string;
  userId: string;
  role: MemberRole;
  status: MemberStatus;
  consultantProfileId: string | null;
}

/** #1851 decision 6 — only an OWNER grants or takes away these roles. */
const OWNER_GATED_ROLES: ReadonlySet<MemberRole> = new Set([
  "OWNER",
  "MAINTAINER",
  "BILLING_ADMIN",
]);

/** The roles that consume or deliver sessions and so carry booking history. */
const PARTICIPANT_ROLES: ReadonlySet<MemberRole> = new Set([
  "LEARNER",
  "EXPERT",
]);

const DEAD_OCCURRENCE = ["CANCELLED", "RESCHEDULED"] as const;

function actorHolds(
  actor: MembershipActor,
  key: "members.role.grant.governance" | "members.remove.force",
): boolean {
  return actor.kind === "idp" || hasOrgPermission(actor.role, key);
}

function isSelf(actor: MembershipActor, membershipId: string): boolean {
  return actor.kind === "member" && actor.membershipId === membershipId;
}

/**
 * #1851 decision 6 — a MAINTAINER manages MANAGER, SUPPORT, EXPERT and LEARNER
 * only. Touching an OWNER, MAINTAINER or BILLING_ADMIN row, or granting one of
 * those roles, needs an OWNER.
 */
export function assertActorMayManage(
  actor: MembershipActor,
  targetRole: MemberRole,
  nextRole?: MemberRole,
): void {
  if (actorHolds(actor, "members.role.grant.governance")) return;
  if (
    OWNER_GATED_ROLES.has(targetRole) ||
    (nextRole !== undefined && OWNER_GATED_ROLES.has(nextRole))
  ) {
    throw new MembershipGuardError(
      "ROLE_REQUIRES_OWNER",
      "Only an Owner can grant or remove the Owner, Maintainer or Billing admin role.",
      403,
    );
  }
}

/**
 * Refuses when `membershipId` is the org's only ACTIVE OWNER. Call it before
 * any move that takes an OWNER out of ACTIVE+OWNER (demote, suspend, remove).
 */
export async function assertNotLastOwner(
  tx: Pick<Tx, "membership">,
  organizationId: string,
  membershipId: string,
): Promise<void> {
  const others = await tx.membership.count({
    where: {
      organizationId,
      role: "OWNER",
      status: "ACTIVE",
      id: { not: membershipId },
    },
  });
  if (others === 0) {
    throw new MembershipGuardError(
      "LAST_OWNER",
      "This is the organisation's only active Owner. Make another member an Owner first.",
      409,
    );
  }
}

/**
 * Whether a LEARNER or EXPERT has anything at this org that a role change
 * would orphan: a booking or seat funded here, a program seat, a delivered
 * session, or an earning from this org's sessions.
 */
export async function countMemberHistory(
  tx: Pick<
    Tx,
    | "appointmentParticipant"
    | "payment"
    | "programAssignment"
    | "appointmentOccurrence"
    | "consultantEarnings"
  >,
  m: GuardedMembership,
): Promise<number> {
  const orgId = m.organizationId;
  const counts = await Promise.all([
    tx.appointmentParticipant.count({
      where: { userId: m.userId, organizationId: orgId },
    }),
    tx.payment.count({ where: { userId: m.userId, organizationId: orgId } }),
    tx.programAssignment.count({ where: { membershipId: m.id } }),
    m.consultantProfileId
      ? tx.appointmentOccurrence.count({
          where: {
            consultantProfileId: m.consultantProfileId,
            appointment: { organizationId: orgId },
          },
        })
      : 0,
    m.consultantProfileId
      ? tx.consultantEarnings.count({
          where: {
            consultantProfileId: m.consultantProfileId,
            payment: { appointment: { organizationId: orgId } },
          },
        })
      : 0,
  ]);
  return counts.reduce((sum, n) => sum + n, 0);
}

export interface RoleChangeInput {
  membership: GuardedMembership;
  to: MemberRole;
  actor: MembershipActor;
  org: { canHost: boolean; canSponsor: boolean };
}

/** REMOVED and ERASED rows are tombstones: no field on them changes here. */
export function assertNotTombstone(m: Pick<GuardedMembership, "status">): void {
  if (m.status === "REMOVED" || m.status === "ERASED") {
    throw new MembershipGuardError(
      "REMOVED_REQUIRES_REINVITE",
      "This member was removed. Send them a new invitation to bring them back.",
      409,
    );
  }
}

/**
 * #1846 bucket C rule 1. Operator roles switch freely (audited by the caller,
 * OWNER rules still apply). LEARNER and EXPERT change role only while they
 * have no history here; otherwise the member is removed and re-invited. A
 * change INTO Expert needs an expert profile that already exists, because a
 * role change must not mint a consultant identity (no lazy ConsultantProfile).
 */
export async function assertRoleChangeAllowed(
  tx: Parameters<typeof countMemberHistory>[0] &
    Pick<Tx, "membership" | "consultantProfile">,
  input: RoleChangeInput,
): Promise<void> {
  const { membership: m, to, actor, org } = input;
  if (to === m.role) return;
  // #1854 — a role write on a tombstone would lazy-create a profile for an
  // erased user; a REMOVED row only comes back through an invitation.
  assertNotTombstone(m);

  if (isSelf(actor, m.id)) {
    throw new MembershipGuardError(
      "SELF_CHANGE",
      "You cannot change your own role. Ask another operator to do it for you.",
      403,
    );
  }
  assertActorMayManage(actor, m.role, to);

  if (isBlockedRoleTransition(m.role, to)) {
    throw new MembershipGuardError(
      "ROLE_TRANSITION_BLOCKED",
      "Members cannot switch between Learner and Expert. Remove, then re-invite with the new role.",
      409,
    );
  }
  if (PARTICIPANT_ROLES.has(m.role) && (await countMemberHistory(tx, m)) > 0) {
    throw new MembershipGuardError(
      "REMOVE_AND_REINVITE",
      "Remove, then re-invite with the new role. This member already has bookings, seats or earnings here.",
      409,
    );
  }

  if (to === "EXPERT") {
    if (!org.canHost) {
      throw new MembershipGuardError(
        "EXPERT_REQUIRES_CANHOST",
        "Expert can only be assigned on host-capable organizations.",
        400,
      );
    }
    const profile = await tx.consultantProfile.findUnique({
      where: { userId: m.userId },
      select: { id: true },
    });
    if (!profile) {
      throw new MembershipGuardError(
        "NOT_A_CONSULTANT",
        "This account has no expert profile yet, so it cannot become an Expert.",
        400,
      );
    }
  }
  if (to === "LEARNER" && !org.canSponsor) {
    throw new MembershipGuardError(
      "LEARNER_REQUIRES_CANSPONSOR",
      "Learner can only be assigned on sponsor-capable organizations.",
      400,
    );
  }

  if (m.role === "OWNER" && m.status === "ACTIVE") {
    await assertNotLastOwner(tx, m.organizationId, m.id);
  }
}

export interface StatusChangeInput {
  membership: GuardedMembership;
  to: MemberStatus;
  actor: MembershipActor;
}

/**
 * Status moves other than removal (removal has its own obligations check in
 * `assertRemovable`). Nobody changes their own status, suspending the last
 * OWNER is refused (N4), a PENDING row only becomes ACTIVE by accepting its
 * invitation, and a REMOVED row only comes back through a new invitation.
 * SCIM is the exception for PENDING: the IdP vouches for the person.
 */
export async function assertStatusChangeAllowed(
  tx: Pick<Tx, "membership">,
  input: StatusChangeInput,
): Promise<void> {
  const { membership: m, to, actor } = input;
  if (to === m.status) return;

  if (isSelf(actor, m.id)) {
    throw new MembershipGuardError(
      "SELF_CHANGE",
      "You cannot change your own status. Ask another operator to do it for you.",
      403,
    );
  }
  assertActorMayManage(actor, m.role);
  assertNotTombstone(m);
  if (m.status === "PENDING" && to === "ACTIVE" && actor.kind === "member") {
    throw new MembershipGuardError(
      "PENDING_REQUIRES_ACCEPT",
      "This person has not accepted their invitation yet. They become active when they accept it.",
      409,
    );
  }
  if (m.role === "OWNER" && m.status === "ACTIVE" && to !== "ACTIVE") {
    await assertNotLastOwner(tx, m.organizationId, m.id);
  }
}

export interface RemovalObligations {
  upcomingSessions: number;
  liveSeats: number;
  overageInflight: number;
  unpaidEarnings: number;
  pendingRefunds: number;
  openDisputes: number;
}

/**
 * What removing this member would strand at THIS org: upcoming org sessions
 * they attend or deliver, live program seats, and money still moving on this
 * org's payments. Unpaid earnings count only this org's unsettled ones (N5):
 * a REFUNDED earning, or one from another org, no longer blocks the removal
 * forever, and neither does a refund on the member's personal booking.
 */
export async function countRemovalObligations(
  tx: Pick<
    Tx,
    | "appointmentOccurrence"
    | "programAssignment"
    | "overageEvent"
    | "consultantEarnings"
    | "refund"
    | "dispute"
  >,
  m: GuardedMembership,
  now: Date,
): Promise<RemovalObligations> {
  const orgId = m.organizationId;
  const upcoming = {
    deletedAt: null,
    startsAt: { gt: now },
    completionStatus: { notIn: [...DEAD_OCCURRENCE] },
  };
  const [
    attending,
    delivering,
    liveSeats,
    overageInflight,
    unpaidEarnings,
    pendingRefunds,
    openDisputes,
  ] = await Promise.all([
    tx.appointmentOccurrence.count({
      where: {
        ...upcoming,
        appointment: {
          deletedAt: null,
          participants: {
            some: {
              userId: m.userId,
              organizationId: orgId,
              role: "CONSULTEE",
              status: { in: LIVE_PARTICIPANT_STATUSES },
            },
          },
        },
      },
    }),
    m.consultantProfileId
      ? tx.appointmentOccurrence.count({
          where: {
            ...upcoming,
            consultantProfileId: m.consultantProfileId,
            appointment: { deletedAt: null, organizationId: orgId },
          },
        })
      : 0,
    tx.programAssignment.count({
      where: {
        membershipId: m.id,
        status: { in: ["ACTIVE", "PAUSED"] },
        periodEnd: { gte: now },
      },
    }),
    tx.overageEvent.count({
      where: {
        chargeStatus: { in: ["PENDING", "ACCRUED"] },
        payment: { userId: m.userId, organizationId: orgId },
      },
    }),
    m.consultantProfileId
      ? tx.consultantEarnings.count({
          where: {
            consultantProfileId: m.consultantProfileId,
            status: {
              in: ["PENDING", "PENDING_TRUST", "HELD", "READY", "BATCHED"],
            },
            payment: { appointment: { organizationId: orgId } },
          },
        })
      : 0,
    tx.refund.count({
      where: {
        status: "PENDING",
        payment: { userId: m.userId, organizationId: orgId },
      },
    }),
    tx.dispute.count({
      where: {
        // Open = not yet terminal (WON/LOST/CHARGE_REFUNDED/WARNING_CLOSED).
        status: {
          in: [
            "WARNING_NEEDS_RESPONSE",
            "WARNING_UNDER_REVIEW",
            "NEEDS_RESPONSE",
            "UNDER_REVIEW",
          ],
        },
        payment: { userId: m.userId, organizationId: orgId },
      },
    }),
  ]);
  return {
    upcomingSessions: attending + delivering,
    liveSeats,
    overageInflight,
    unpaidEarnings,
    pendingRefunds,
    openDisputes,
  };
}

export interface RemovalInput {
  membership: GuardedMembership;
  actor: MembershipActor;
  /** OWNER-only override past the obligations check (#779 §C). */
  force: boolean;
  now: Date;
}

/**
 * The one removal guard behind DELETE and PATCH → REMOVED (ORG-07). Returns
 * the obligation counts so the audit row can record a forced removal.
 */
export async function assertRemovable(
  tx: Parameters<typeof countRemovalObligations>[0] & Pick<Tx, "membership">,
  input: RemovalInput,
): Promise<{ obligations: RemovalObligations; forced: boolean }> {
  const { membership: m, actor, force, now } = input;
  if (isSelf(actor, m.id)) {
    throw new MembershipGuardError(
      "SELF_CHANGE",
      "You cannot remove yourself. Ask another operator to do it for you.",
      403,
    );
  }
  assertActorMayManage(actor, m.role);
  if (m.role === "OWNER" && m.status === "ACTIVE") {
    await assertNotLastOwner(tx, m.organizationId, m.id);
  }

  const obligations = await countRemovalObligations(tx, m, now);
  const total = Object.values(obligations).reduce((sum, n) => sum + n, 0);
  if (total > 0 && !(force && actorHolds(actor, "members.remove.force"))) {
    throw new MembershipGuardError(
      "MEMBER_HAS_OBLIGATIONS",
      "This member still has upcoming sessions, program seats or money in progress here. Settle those first, or ask an Owner to remove them anyway.",
      409,
      { ...obligations },
    );
  }
  return { obligations, forced: total > 0 };
}
