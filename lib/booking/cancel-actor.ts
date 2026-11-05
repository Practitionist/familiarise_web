import prisma from "@/lib/prisma";
import { isPrivileged } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { resolveOrgActor, type OrgActor } from "@/lib/booking/org-actor";

type CancelActorPlan = {
  consultantProfileId: string | null;
  organizationId: string | null;
  consultantProfile: { user: { id: string } } | null;
} | null;

type CancelActorRequest = {
  requestedById: string;
  requestedBy: { user: { id: string } };
};

/** The booking facts the cancel actor reads; both the preview and the POST load at least this. */
export type CancelActorAppointment = {
  organizationId: string | null;
  consultationId?: string | null;
  subscriptionId?: string | null;
  consultation:
    (CancelActorRequest & { consultationPlan: CancelActorPlan }) | null;
  subscription:
    (CancelActorRequest & { subscriptionPlan: CancelActorPlan }) | null;
  webinar: { webinarPlan: CancelActorPlan } | null;
  class: { classPlan: CancelActorPlan } | null;
};

export type CancelActorUser = {
  id: string;
  role?: string | null;
  consultantProfileId?: string | null;
  consulteeProfileId?: string | null;
};

/** Who is cancelling and on which side of the refund tiers they sit. */
export type CancelActor = {
  /** A party to the booking, or an operator of the plan's host org. */
  isParticipant: boolean;
  isPrivilegedUser: boolean;
  isHostOrgOperator: boolean;
  /** The funding org's act-for-org membership, for a non-party who holds the grant. */
  orgActor: OrgActor | null;
  /** May cancel at all (a privileged non-party still needs the back-office door). */
  authorized: boolean;
  /** The buyer of a 1:1 booking, held to the suspended-member refusal. */
  isLearner: boolean;
  consultantUserId: string | null;
  consulteeUserId: string | null;
  hostProfileId: string | null;
  /** Not the buyer's choice: the expert, a platform admin or a host-org operator. */
  isConsultantInitiated: boolean;
  /** The expert themself acted (not an operator or admin); a paid booking earns a strike. */
  isExpertSideCancel: boolean;
};

function planOf(appointment: CancelActorAppointment): CancelActorPlan {
  return (
    appointment.consultation?.consultationPlan ??
    appointment.subscription?.subscriptionPlan ??
    appointment.webinar?.webinarPlan ??
    appointment.class?.classPlan ??
    null
  );
}

/** An active operator (catalog.manage) of the plan's live host org. */
export async function isHostOrgOperatorOf(
  userId: string,
  hostOrganizationId: string | null,
): Promise<boolean> {
  if (!hostOrganizationId) return false;
  const membership = await prisma.membership.findUnique({
    where: {
      userId_organizationId: { userId, organizationId: hostOrganizationId },
    },
    select: {
      status: true,
      role: true,
      organization: { select: { status: true } },
    },
  });
  return (
    membership?.status === "ACTIVE" &&
    membership.organization.status !== "DEACTIVATED" &&
    hasOrgPermission(membership.role, "catalog.manage")
  );
}

/**
 * The one actor derivation the cancel preview and the cancel POST share, so the
 * preview never quotes a tier (or refuses a viewer) the POST would not.
 */
export async function resolveCancelActor(
  appointment: CancelActorAppointment,
  user: CancelActorUser,
): Promise<CancelActor> {
  const plan = planOf(appointment);
  const request = appointment.consultation ?? appointment.subscription ?? null;
  const consultantUserId = plan?.consultantProfile?.user.id ?? null;
  const consulteeUserId = request?.requestedBy.user.id ?? null;
  const hostProfileId = plan?.consultantProfileId ?? null;

  const isHostOrgOperator = await isHostOrgOperatorOf(
    user.id,
    plan?.organizationId ?? null,
  );
  const isPlanConsultant =
    !!user.consultantProfileId && user.consultantProfileId === hostProfileId;
  // Attendees of a class or webinar leave through the roster route; this door
  // is the organiser's whole-event cancel.
  const isLearner =
    !!request &&
    !!user.consulteeProfileId &&
    user.consulteeProfileId === request.requestedById;
  const isParticipant = isPlanConsultant || isLearner || isHostOrgOperator;

  const isPrivilegedUser = isPrivileged(user.role);
  const orgActor =
    !isParticipant && !isPrivilegedUser
      ? await resolveOrgActor(user.id, appointment, "cancel")
      : null;

  const isBuyer = user.id === consulteeUserId;
  const isExpert = !!user.consultantProfileId && consultantUserId === user.id;
  return {
    isParticipant,
    isPrivilegedUser,
    isHostOrgOperator,
    orgActor,
    authorized: isParticipant || isPrivilegedUser || orgActor !== null,
    isLearner,
    consultantUserId,
    consulteeUserId,
    hostProfileId,
    // Party rules beat operator rules: an operator who bought the booking
    // cancels at the buyer's tier.
    isConsultantInitiated:
      isExpert ||
      (isPrivilegedUser && !isBuyer) ||
      (isHostOrgOperator && !isBuyer),
    // An operator's cancel is recorded under the operator and strikes nobody.
    isExpertSideCancel: isExpert,
  };
}
