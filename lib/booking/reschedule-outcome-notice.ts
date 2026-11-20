import prisma, { type PrismaLike } from "@/lib/prisma";
import { reportSentryError } from "@/lib/observability/report";
import { attemptTrigger, notifyAppointmentRescheduled } from "@/lib/novu";
import {
  attemptStaged,
  stageAppointmentRescheduledEmail,
  type StagedRecipientEmail,
} from "@/lib/email/senders/booking";
import type { StagedTrigger } from "@/lib/novu/outbox";
import {
  bookingNoticeScopes,
  notificationScope,
  type RescheduleOutcomeFields,
} from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";
import type { RequiredOverride } from "@/lib/notifications/required-notices";

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
        select: {
          title: true,
          organizationId: true,
          consultantProfile: PARTY_USER,
        },
      },
    },
  },
  subscription: {
    select: {
      requestedBy: PARTY_USER,
      subscriptionPlan: {
        select: {
          title: true,
          organizationId: true,
          consultantProfile: PARTY_USER,
        },
      },
    },
  },
  trial: {
    select: {
      consulteeProfile: PARTY_USER,
      subscriptionPlan: {
        select: {
          title: true,
          organizationId: true,
          consultantProfile: PARTY_USER,
        },
      },
    },
  },
} as const;

type PartyUser = { id: string; name: string | null };
type PlanSide = {
  title: string;
  organizationId: string | null;
  consultantProfile: { user: PartyUser };
};

export interface RescheduleParties {
  planTitle: string;
  /** The plan's host organisation: the expert's notice scope. */
  hostOrganizationId: string | null;
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
    hostOrganizationId: plan.organizationId,
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

export interface RescheduleNotice {
  appointment: {
    id: string;
    organizationId: string | null;
    appointmentType: string;
  };
  parties: RescheduleParties;
  /** Everyone told. */
  userIds: readonly string[];
  /** One key per request and outcome, so a later request on the same session is its own notice. */
  dedupeKey: string;
  required?: RequiredOverride;
  /** What happened and the times it names. */
  variant: RescheduleOutcomeFields;
}

export interface StagedRescheduleNotice {
  bells: StagedTrigger[];
  emails: StagedRecipientEmail[];
}

/**
 * Stages one reschedule notice, bell and email, on `db` (the change's own
 * transaction where there is one); attempt it after the commit. The expert is
 * scoped by the plan's host organisation, everyone else by the booking's sponsor.
 */
export async function stageRescheduleNotice(
  db: PrismaLike,
  n: RescheduleNotice,
): Promise<StagedRescheduleNotice> {
  const { planTitle, consultantUser, consulteeUser, hostOrganizationId } =
    n.parties;
  const staged: StagedRescheduleNotice = { bells: [], emails: [] };
  const groups = bookingNoticeScopes({
    hostOrganizationId,
    hostUserIds: n.userIds.filter((id) => id === consultantUser.id),
    buyers: n.userIds.map((userId) => ({
      userId,
      organizationId: n.appointment.organizationId,
    })),
  });
  const { oldDateTime, newDateTime } = n.variant;
  // A trial's booked notice carries no calendar link, so its move carries none.
  const holdsCalendarLink =
    n.appointment.appointmentType.toUpperCase() !== "TRIAL";
  for (const group of groups) {
    const dashboardUrl = notificationHref(group.organizationId, "appointments");
    const bells = await notifyAppointmentRescheduled(
      group.userIds,
      {
        ...notificationScope(group.organizationId),
        ...n.variant,
        appointmentId: n.appointment.id,
        appointmentType: n.appointment.appointmentType,
        consultantName: consultantUser.name || "Consultant",
        consulteeName: consulteeUser.name || "Consultee",
        planTitle,
        dashboardUrl,
      },
      {
        tx: db,
        deferAttempt: true,
        dedupeKey: n.dedupeKey,
        ...(n.required ? { required: n.required } : {}),
      },
    );
    staged.bells.push(
      ...bells.flatMap((bell) => (bell.staged ? [bell.staged] : [])),
    );
    staged.emails.push(
      ...(await stageAppointmentRescheduledEmail(db, {
        appointmentId: n.appointment.id,
        userIds: group.userIds,
        outcome: n.variant.outcome,
        appointmentType: n.appointment.appointmentType,
        oldStartsAt: oldDateTime ? new Date(oldDateTime) : null,
        newStartsAt: newDateTime ? new Date(newDateTime) : null,
        calendarFor: holdsCalendarLink ? [consulteeUser.id] : [],
        ...(n.required ? { requiredFor: n.required.recipients } : {}),
        dashboardUrl,
      })),
    );
  }
  return staged;
}

/** Attempts a staged reschedule notice inline; what it cannot settle waits for the relays. */
export async function attemptRescheduleNotice(
  staged: StagedRescheduleNotice,
  emailBudgetMs: number,
): Promise<void> {
  // A re-staged bell comes back with the same id; attempt it once.
  const bells = [...new Map(staged.bells.map((b) => [b.id, b])).values()];
  await Promise.all([
    ...bells.map((bell) => attemptTrigger(bell)),
    staged.emails.length > 0
      ? attemptStaged(staged.emails, "APPOINTMENT_RESCHEDULED", emailBudgetMs)
      : null,
  ]);
}

/**
 * Tell every party that a reschedule ended with the booking back on its
 * original time: someone withdrew it, or nobody answered and it expired. A
 * lapse is required for every party, a withdrawal for everyone but the person
 * who withdrew it.
 *
 * Never throws: the ending has committed, and a notice failure must not undo
 * it or abort a sweep. `oldStartsAt` is the earliest restored session, so the
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
        resolvedById: true,
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

    const userIds = [
      detail.initiatedById,
      parties.consultantUser.id,
      parties.consulteeUser.id,
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
    const withdrawnBy = detail.resolvedById ?? detail.initiatedById;
    const required =
      outcome === "EXPIRED"
        ? { kind: "PROPOSAL_LAPSED" as const, recipients: userIds }
        : {
            kind: "PROPOSAL_WITHDRAWN" as const,
            recipients: userIds.filter((id) => id !== withdrawnBy),
          };

    const staged = await stageRescheduleNotice(prisma, {
      appointment: appt,
      parties,
      userIds,
      dedupeKey: `reschedule-restored:${rescheduleRequestId}:${outcome}`,
      required,
      variant: {
        outcome,
        ...(restored ? { oldDateTime: restored.startsAt.toISOString() } : {}),
      },
    });
    await attemptRescheduleNotice(staged, emailBudgetMs);
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
