import type { RescheduleInitiatorRole } from "@prisma/client";
import type { Session } from "@/lib/auth";
import { resolveEventHostActor } from "@/lib/auth-helpers";
import { isOrgAdminOfAppointment } from "@/lib/booking/org-actor";
import { isSuspendedInFundingOrg } from "@/lib/enterprise/suspended-member-sessions";

/** The booking fields an open reschedule's side check reads. */
export const RESCHEDULE_SIDE_APPOINTMENT_SELECT = {
  consultationId: true,
  subscriptionId: true,
  organizationId: true,
  consultation: { select: { requestedBy: { select: { userId: true } } } },
  subscription: { select: { requestedBy: { select: { userId: true } } } },
  trial: {
    select: {
      consultantProfileId: true,
      consulteeProfile: { select: { userId: true } },
    },
  },
} as const;

type SideAppointment = {
  consultationId: string | null;
  subscriptionId: string | null;
  organizationId: string | null;
  consultation: { requestedBy: { userId: string } } | null;
  subscription: { requestedBy: { userId: string } } | null;
  trial: {
    consultantProfileId: string;
    consulteeProfile: { userId: string };
  } | null;
};

function eventOf(appointment: SideAppointment) {
  if (appointment.consultationId) {
    return { type: "consultation" as const, id: appointment.consultationId };
  }
  if (appointment.subscriptionId) {
    return { type: "subscription" as const, id: appointment.subscriptionId };
  }
  return null;
}

export function consulteeUserIdOf(
  appointment: SideAppointment | null | undefined,
): string | undefined {
  return (
    appointment?.consultation?.requestedBy.userId ??
    appointment?.subscription?.requestedBy.userId ??
    appointment?.trial?.consulteeProfile.userId
  );
}

/**
 * Whether this caller acts for one side of a booking today: the consultee side
 * is the buyer or the paying org's admin; the consultant side is the expert or
 * a host-org operator, and for a trial only its own expert.
 */
export async function actsForRescheduleSide(
  side: RescheduleInitiatorRole,
  appointment: SideAppointment | null,
  session: Session,
): Promise<boolean> {
  if (!appointment) return false;
  if (side === "CONSULTEE") {
    if (session.user.id === consulteeUserIdOf(appointment)) return true;
    return isOrgAdminOfAppointment(session.user.id, appointment, "reschedule");
  }
  if (appointment.trial) {
    return (
      session.user.consultantProfileId === appointment.trial.consultantProfileId
    );
  }
  const event = eventOf(appointment);
  if (!event) return false;
  // Judged as a party only: without the role, a STAFF or ADMIN expert is still
  // the expert, and a non-party operator answers null rather than "staff".
  const host = await resolveEventHostActor(
    { user: { ...session.user, role: null } },
    event.type,
    event.id,
  );
  return host === "consultant" || host === "host-org";
}

/** The booking's learner is suspended in the organisation funding it, so moves nothing. */
export async function isSuspendedLearnerOf(
  appointment: SideAppointment | null | undefined,
  userId: string,
): Promise<boolean> {
  return (
    userId === consulteeUserIdOf(appointment) &&
    isSuspendedInFundingOrg(userId, appointment?.organizationId)
  );
}
