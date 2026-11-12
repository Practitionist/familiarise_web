import prisma from "@/lib/prisma";
import { reportSentryError } from "@/lib/observability/report";
import { notifyAppointmentRescheduled } from "@/lib/novu";
import { sendAppointmentRescheduledEmail } from "@/lib/email";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";

const PARTY_USER = { select: { user: { select: { id: true, name: true } } } };

/**
 * The parties' names and the plan title a reschedule notice needs, for each
 * 1:1 kind that can be moved (consultation, subscription, trial). Spread into
 * an appointment select and read back with {@link rescheduleParties}.
 */
export const RESCHEDULE_PARTIES_SELECT = {
  consultation: {
    select: {
      requestedBy: PARTY_USER,
      consultationPlan: {
        select: { title: true, consultantProfile: PARTY_USER },
      },
    },
  },
  subscription: {
    select: {
      requestedBy: PARTY_USER,
      subscriptionPlan: {
        select: { title: true, consultantProfile: PARTY_USER },
      },
    },
  },
  trial: {
    select: {
      consulteeProfile: PARTY_USER,
      subscriptionPlan: {
        select: { title: true, consultantProfile: PARTY_USER },
      },
    },
  },
} as const;

type PartyUser = { id: string; name: string | null };
type PlanSide = {
  title: string;
  consultantProfile: { user: PartyUser };
};

export interface RescheduleParties {
  planTitle: string;
  consultantUser: PartyUser;
  consulteeUser: PartyUser;
}

/** The two parties of a moved booking, or null for a kind that never reschedules. */
export function rescheduleParties(appointment: {
  consultation?: {
    requestedBy: { user: PartyUser };
    consultationPlan: PlanSide;
  } | null;
  subscription?: {
    requestedBy: { user: PartyUser };
    subscriptionPlan: PlanSide;
  } | null;
  trial?: {
    consulteeProfile: { user: PartyUser };
    subscriptionPlan: PlanSide;
  } | null;
}): RescheduleParties | null {
  const pick = (consultee: PartyUser, plan: PlanSide): RescheduleParties => ({
    planTitle: plan.title,
    consultantUser: plan.consultantProfile.user,
    consulteeUser: consultee,
  });
  if (appointment.consultation) {
    return pick(
      appointment.consultation.requestedBy.user,
      appointment.consultation.consultationPlan,
    );
  }
  if (appointment.subscription) {
    return pick(
      appointment.subscription.requestedBy.user,
      appointment.subscription.subscriptionPlan,
    );
  }
  if (appointment.trial) {
    return pick(
      appointment.trial.consulteeProfile.user,
      appointment.trial.subscriptionPlan,
    );
  }
  return null;
}

/**
 * Tell both parties that a reschedule ended with the booking back on its
 * original time: the initiator withdrew it (PR 2e), or nobody answered and it
 * expired (#1846, #1527 decision 9). One event on the existing
 * `appointment-rescheduled` family and its email twin, both awaited, because a
 * trigger left running after the response is lost when the instance freezes.
 *
 * Never throws: the ending has committed, and a notice failure must not undo
 * it or abort a sweep. `oldDateTime` is the earliest restored session, so the
 * copy can say which time stands.
 */
export async function notifyRescheduleRestored(
  rescheduleRequestId: string,
  outcome: "WITHDRAWN" | "EXPIRED",
  emailBudgetMs: number,
): Promise<void> {
  try {
    const detail = await prisma.rescheduleRequest.findUnique({
      where: { id: rescheduleRequestId },
      select: {
        initiatedById: true,
        releasedOccurrenceIds: true,
        appointment: {
          select: {
            id: true,
            organizationId: true,
            appointmentType: true,
            ...RESCHEDULE_PARTIES_SELECT,
          },
        },
      },
    });
    const appt = detail?.appointment;
    const parties = appt ? rescheduleParties(appt) : null;
    if (!detail || !parties || !appt) return;

    const { planTitle, consultantUser, consulteeUser } = parties;
    const userIds = [
      detail.initiatedById,
      consultantUser.id,
      consulteeUser.id,
    ].filter((id, i, arr) => arr.indexOf(id) === i);

    const restored = await prisma.appointmentOccurrence.findFirst({
      where: {
        id: { in: detail.releasedOccurrenceIds },
        completionStatus: "SCHEDULED",
        deletedAt: null,
      },
      orderBy: { startsAt: "asc" },
      select: { startsAt: true },
    });
    const dashboardUrl = notificationHref(appt.organizationId, "appointments");

    await notifyAppointmentRescheduled(userIds, {
      ...notificationScope(appt.organizationId),
      appointmentType: appt.appointmentType,
      consultantName: consultantUser.name || "Consultant",
      consulteeName: consulteeUser.name || "Consultee",
      planTitle,
      dashboardUrl,
      outcome,
      ...(restored ? { oldDateTime: restored.startsAt.toISOString() } : {}),
    });
    // #1653 — the email twin; the sender never throws.
    await sendAppointmentRescheduledEmail(
      {
        appointmentId: appt.id,
        userIds,
        outcome,
        appointmentType: appt.appointmentType,
        oldStartsAt: restored?.startsAt ?? null,
        dashboardUrl,
      },
      emailBudgetMs,
    );
  } catch (notifyErr) {
    reportSentryError(
      notifyErr instanceof Error ? notifyErr : new Error(String(notifyErr)),
      {
        subsystem: "bookings",
        op:
          outcome === "EXPIRED"
            ? "reschedule-expiry-notify"
            : "reschedule-withdraw-notify",
        expected: true,
      },
    );
  }
}
