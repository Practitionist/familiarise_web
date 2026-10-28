/**
 * Shared read for the consultant Home dashboard: the API route
 * (`/api/dashboard/consultant/[id]`) and the Home server page both call it,
 * so SSR hydration and the client `useQuery` resolve identical payloads. It
 * reads only what Home renders, every read bounded through `runBounded` for
 * the one-connection serverless pool.
 *
 * Auth + access checks stay in the route; this function carries no
 * request/session coupling and is callable from a Server Component.
 *
 * Money fields are `number` (read-path `$extends`); the `_sum` aggregates
 * bypass that extension and go through `sumPaise`. Dates stay raw `Date`.
 */

import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import prisma from "@/lib/prisma";
import { scopeToWhereOrgId } from "@/lib/api/scope/parse";
import { runBounded } from "@/lib/db/bounded";
import { readByIds } from "@/lib/data/read-by-ids";
import { readPayoutSetupNeeded } from "@/lib/data/needs-you";
import { payoutSettingsHref } from "@/lib/payments/payouts/payout-requirements";
import { reportSentryError } from "@/lib/observability/report";
import { ENABLE_LIVE_PAYOUTS } from "@/lib/feature-flags";
import type { Prisma } from "@prisma/client";
import { subscriptionPlanEnd } from "@/lib/booking/entitlement";
import { getConsultantResponseRate } from "@/lib/booking/response-rate";
import { sumPaise } from "@/lib/payments/utils/money";
import { toPlain } from "@/lib/data/serialize";
import { resolveViewerZone } from "@/lib/time/viewer-zone";
import {
  readConsultantNeedsYou,
  readSessionsDelivered,
} from "@/lib/data/consultant-needs-you";
import type { TConsultantDashboardResponse } from "@/types/consultant-events";

// =============================================================================
// Prisma Query Types - Derived from actual query shape for type safety
// =============================================================================

/** Home widgets only need identity + avatar; omit phone/role from the graph. */
const userSelectFields = {
  id: true,
  name: true,
  email: true,
  image: true,
} as const;

/** Home surfaces a handful of cards — history lives on /appointments. */
const HOME_APPOINTMENTS_TAKE = 20;

/**
 * #1166 ORG-1 — personal Home is B2C only (ADR 19), matching the sibling
 * Appointments page's personal filter; org delivery lives on that org's own
 * dashboard. #674 defect 13 — the pin is taken from the shared projector
 * rather than written out as a literal at each of the four sites below, so
 * "what personal means" has exactly one definition on the platform.
 */
const PERSONAL_ORG_PIN = scopeToWhereOrgId({ kind: "personal" });

/** The "Organisation sessions" strip shows the next few, not the book. */
const HOME_ORG_SESSIONS_TAKE = 5;
/** Every appointment this consultant owns or collaborates on, personal only. */
const consultantAppointmentScope = (consultantProfileId: string) =>
  ({
    ...PERSONAL_ORG_PIN,
    OR: consultantDeliveryArms(consultantProfileId),
  }) satisfies Prisma.AppointmentWhereInput;

/**
 * #1703 B13 — the same delivery predicate with the personal pin inverted:
 * an org-funded session this consultant must still show up for. Read as
 * metadata only (ADR 20): org name, time, join state.
 */
const consultantOrgAppointmentScope = (consultantProfileId: string) =>
  ({
    organizationId: { not: null },
    OR: consultantDeliveryArms(consultantProfileId),
  }) satisfies Prisma.AppointmentWhereInput;

/** A webinar or class still to deliver, as the other live-event readers count it. */
const LIVE_EVENT = { in: ["SCHEDULED" as const, "IN_PROGRESS" as const] };

const consultantDeliveryArms = (
  consultantProfileId: string,
): Prisma.AppointmentWhereInput[] => [
  {
    consultation: {
      consultationPlan: { consultantProfileId },
      status: "APPROVED" as const,
    },
  },
  {
    subscription: {
      subscriptionPlan: { consultantProfileId },
      status: "APPROVED" as const,
    },
  },
  {
    webinar: {
      webinarPlan: { consultantProfileId },
      status: LIVE_EVENT,
    },
  },
  {
    // Collaborated webinars (co-host, moderator, etc.)
    webinar: {
      webinarPlan: {
        collaborators: {
          some: { consultantProfileId, status: "ACCEPTED" as const },
        },
      },
      status: LIVE_EVENT,
    },
  },
  {
    class: {
      classPlan: { consultantProfileId },
      status: LIVE_EVENT,
    },
  },
  {
    // Collaborated classes (co-instructor, TA, etc.)
    class: {
      classPlan: {
        collaborators: {
          some: { consultantProfileId, status: "ACCEPTED" as const },
        },
      },
      status: LIVE_EVENT,
    },
  },
  {
    trial: {
      consultantProfileId,
      status: "SCHEDULED" as const,
    },
  },
];

/** A plan owner as Home renders them: avatar and name. */
const planOwnerSelect = {
  consultantProfileId: true,
  consultantProfile: {
    select: {
      id: true,
      user: { select: { id: true, name: true, image: true } },
    },
  },
} as const;

/** Accepted co-hosts, for the viewer's role badge and the host avatar. */
const acceptedCollaboratorsSelect = {
  where: { status: "ACCEPTED" as const },
  select: {
    id: true,
    role: true,
    consultantProfileId: true,
    consultantProfile: {
      select: {
        id: true,
        user: { select: { id: true, name: true, image: true } },
      },
    },
  },
};

/** Exactly what Home's appointment transform and card helpers read. */
const appointmentSelect = {
  id: true,
  appointmentType: true,
  organizationId: true,
  occurrences: {
    where: { deletedAt: null },
    orderBy: { startsAt: "asc" as const },
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      isTentative: true,
      completionStatus: true,
      meeting: {
        select: { id: true, endedAt: true, endedReason: true },
      },
    },
  },
  consultation: {
    select: {
      id: true,
      status: true,
      consultationPlan: {
        select: { id: true, title: true, ...planOwnerSelect },
      },
      requestedBy: { select: { id: true, user: { select: userSelectFields } } },
    },
  },
  subscription: {
    select: {
      id: true,
      subscriptionPlan: {
        select: {
          id: true,
          title: true,
          // calculateSessionProgress reads the entitlement inputs.
          totalSessions: true,
          sessionsPerWeek: true,
          durationInMonths: true,
          ...planOwnerSelect,
        },
      },
      requestedBy: { select: { id: true, user: { select: userSelectFields } } },
      schedulingPeriodStartsAt: true,
      planEndsAt: true,
      // #1766 — Home's session progress reads the frozen entitlement.
      sessionsTotal: true,
      schedulingTimezone: true,
      status: true,
    },
  },
  webinar: {
    select: {
      id: true,
      status: true,
      webinarPlan: {
        select: {
          id: true,
          title: true,
          ...planOwnerSelect,
          collaborators: acceptedCollaboratorsSelect,
        },
      },
    },
  },
  class: {
    select: {
      id: true,
      status: true,
      classPlan: {
        select: {
          id: true,
          title: true,
          ...planOwnerSelect,
          collaborators: acceptedCollaboratorsSelect,
        },
      },
    },
  },
  trial: {
    select: {
      id: true,
      status: true,
      subscriptionPlan: {
        select: {
          id: true,
          title: true,
          trialDurationMinutes: true,
          trialPriceInPaise: true,
        },
      },
      consulteeProfile: {
        select: { id: true, user: { select: userSelectFields } },
      },
    },
  },
} satisfies Prisma.AppointmentSelect;

// Derived via the extended client — raw GetPayload would re-introduce
// bigint money fields.
type DashboardAppointment = Prisma.Result<
  typeof prisma.appointment,
  { select: typeof appointmentSelect },
  "findFirstOrThrow"
>;

// =============================================================================
// Shared Read
// =============================================================================

/** Midnight today and on the 1st of this month, on the consultant's own clock. */
export function homeBoundaries(
  now: Date,
  zone: string,
): { startOfToday: Date; startOfMonth: Date } {
  const day = formatInTimeZone(now, zone, "yyyy-MM-dd");
  return {
    startOfToday: fromZonedTime(`${day}T00:00:00`, zone),
    startOfMonth: fromZonedTime(`${day.slice(0, 7)}-01T00:00:00`, zone),
  };
}

/**
 * Read + transform the consultant Home dashboard payload. Returns the
 * inner shape (NOT wrapped in `{ success, data }`). Auth/access checks
 * are the caller's responsibility.
 */
export async function getConsultantDashboard(
  consultantProfileId: string,
  now: Date = new Date(),
): Promise<TConsultantDashboardResponse> {
  // "Today" and "this month" are the consultant's own days, whichever server
  // renders them; an unknown saved zone falls back to UTC.
  const profile = await prisma.consultantProfile.findUnique({
    where: { id: consultantProfileId },
    select: {
      publishedRatingOneToOne: true,
      publishedRatingGroup: true,
      ratedClientsOneToOne: true,
      ratedEventsGroup: true,
      user: { select: { timezone: true } },
    },
  });
  const zone = resolveViewerZone({ userTimezone: profile?.user.timezone });
  const { startOfToday, startOfMonth } = homeBoundaries(now, zone);

  // Which appointments Home shows: Appointment has no start column, so rank
  // on the slot table (indexed on startsAt, endsAt) and keep the soonest ids.
  // Anchored on endsAt >= start of today so a session running now survives.
  const [soonestSlots, orgSessionRows, earningsByStatus] = await runBounded([
    () =>
      prisma.appointmentOccurrence.findMany({
        where: {
          deletedAt: null,
          // A released (RESCHEDULED) slot keeps its old time and a tentative
          // hold belongs to the Requests tab; neither is on the Home calendar.
          completionStatus: "SCHEDULED",
          isTentative: false,
          endsAt: { gte: startOfToday },
          appointment: consultantAppointmentScope(consultantProfileId),
        },
        select: { appointmentId: true },
        orderBy: { startsAt: "asc" },
        take: HOME_APPOINTMENTS_TAKE * 5,
      }),
    // The next org-funded sessions this consultant delivers: the same
    // occurrence predicate with the org pin inverted; metadata only.
    () =>
      prisma.appointmentOccurrence.findMany({
        where: {
          deletedAt: null,
          completionStatus: "SCHEDULED",
          isTentative: false,
          endsAt: { gte: startOfToday },
          appointment: consultantOrgAppointmentScope(consultantProfileId),
        },
        select: {
          id: true,
          appointmentId: true,
          startsAt: true,
          endsAt: true,
          isTentative: true,
          completionStatus: true,
          meeting: { select: { id: true, endedAt: true, endedReason: true } },
          appointment: {
            select: {
              organizationId: true,
              organization: { select: { name: true } },
            },
          },
        },
        orderBy: { startsAt: "asc" },
        take: HOME_ORG_SESSIONS_TAKE,
        relationLoadStrategy: "join",
      }),
    // Deliberately GLOBAL (no org filter): payouts settle one instrument
    // across every context. Available = READY + BATCHED, net of refunds.
    () =>
      prisma.consultantEarnings.groupBy({
        by: ["status"],
        where: { consultantProfileId, status: { in: ["READY", "BATCHED"] } },
        _sum: { consultantSharePaise: true, refundedShareAmount: true },
      }),
  ] as const);
  const homeAppointmentIds = [
    ...new Set(soonestSlots.map((s) => s.appointmentId)),
  ].slice(0, HOME_APPOINTMENTS_TAKE);
  const orgSessions = orgSessionRows.map((row) => ({
    occurrenceId: row.id,
    appointmentId: row.appointmentId,
    organizationId: row.appointment.organizationId ?? "",
    organizationName: row.appointment.organization?.name ?? "Organisation",
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    isTentative: row.isTentative,
    completionStatus: row.completionStatus,
    meeting: row.meeting,
  }));

  // The appointments Home renders, in one joined statement; an empty id list
  // costs no round trip.
  const appointmentsRaw = await readByIds(homeAppointmentIds, () =>
    prisma.appointment.findMany({
      where: { id: { in: homeAppointmentIds } },
      select: appointmentSelect,
      relationLoadStrategy: "join",
    }),
  );

  // Sort appointments by slot start time (matching original API behavior)
  const sortedAppointments = appointmentsRaw.sort((a, b) => {
    const aTime = a.occurrences?.[0]?.startsAt;
    const bTime = b.occurrences?.[0]?.startsAt;

    if (!aTime && !bTime) return 0;
    if (!aTime) return 1;
    if (!bTime) return -1;

    return new Date(aTime).getTime() - new Date(bTime).getTime();
  });

  // Transform appointments (same logic as fetchHelpers.ts)
  const transformedAppointments = sortedAppointments.map(
    (appointment: DashboardAppointment) => ({
      id: appointment.id,
      appointmentType: appointment.appointmentType,
      // Org-funding marker — drives the "Sponsored · <Org>" badge on
      // the consultant Home + Appointments surfaces. Previously dropped
      // by this manual field-mapping transform.
      organizationId: appointment.organizationId,
      occurrences: appointment.occurrences.map((slot) => ({
        id: slot.id,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        isTentative: slot.isTentative,
        completionStatus: slot.completionStatus,
        meeting: slot.meeting ?? null,
      })),
      consultation: appointment.consultation
        ? {
            id: appointment.consultation.id,
            consultationPlan: {
              ...appointment.consultation.consultationPlan,
              consultantProfile:
                appointment.consultation.consultationPlan.consultantProfile,
            },
            status: appointment.consultation.status,
            requestedBy: {
              id: appointment.consultation.requestedBy?.id ?? "",
              user: {
                name: appointment.consultation.requestedBy?.user?.name ?? null,
                image:
                  appointment.consultation.requestedBy?.user?.image ?? null,
              },
            },
          }
        : undefined,
      subscription: appointment.subscription
        ? {
            id: appointment.subscription.id,
            subscriptionPlan: {
              ...appointment.subscription.subscriptionPlan,
              consultantProfile:
                appointment.subscription.subscriptionPlan.consultantProfile,
            },
            status: appointment.subscription.status,
            requestedBy: {
              id: appointment.subscription.requestedBy?.id ?? "",
              user: {
                name: appointment.subscription.requestedBy?.user?.name ?? null,
                image:
                  appointment.subscription.requestedBy?.user?.image ?? null,
              },
            },
            startDate: new Date(
              appointment.subscription.schedulingPeriodStartsAt,
            ).toISOString(),
            endDate: subscriptionPlanEnd(
              appointment.subscription,
            ).toISOString(),
            // #1766 — the entitlement inputs calculateSessionProgress reads.
            sessionsTotal: appointment.subscription.sessionsTotal,
            schedulingPeriodStartsAt:
              appointment.subscription.schedulingPeriodStartsAt,
            schedulingTimezone: appointment.subscription.schedulingTimezone,
          }
        : undefined,
      webinar: appointment.webinar
        ? {
            id: appointment.webinar.id,
            webinarPlan: {
              ...appointment.webinar.webinarPlan,
              consultantProfile:
                appointment.webinar.webinarPlan.consultantProfile,
              collaborators:
                appointment.webinar.webinarPlan.collaborators ?? [],
            },
            status: appointment.webinar.status,
          }
        : undefined,
      class: appointment.class
        ? {
            id: appointment.class.id,
            classPlan: {
              ...appointment.class.classPlan,
              consultantProfile: appointment.class.classPlan.consultantProfile,
              collaborators: appointment.class.classPlan.collaborators ?? [],
            },
            status: appointment.class.status,
          }
        : undefined,
      trial: appointment.trial
        ? {
            id: appointment.trial.id,
            status: appointment.trial.status,
            subscriptionPlan: appointment.trial.subscriptionPlan,
            consulteeProfile: {
              id: appointment.trial.consulteeProfile?.id ?? "",
              user: {
                name: appointment.trial.consulteeProfile?.user?.name ?? null,
                image: appointment.trial.consulteeProfile?.user?.image ?? null,
              },
            },
          }
        : undefined,
    }),
  );

  // Supplementary cards: a failed read degrades its card, never Home. Each
  // runs its own reads in sequence, so these stay within the pool bound.
  const [responseRate, sessionsDelivered, payoutNeeded] = await runBounded([
    () => getConsultantResponseRate(consultantProfileId, now),
    () =>
      readSessionsDelivered(consultantProfileId, startOfMonth).catch(
        () => undefined,
      ),
    () =>
      readPayoutSetupNeeded(consultantProfileId).catch((error) => {
        reportSentryError(error, { subsystem: "payments", expected: true });
        return false;
      }),
  ] as const);
  // NeedsYou bounds its own count, so it runs alone.
  const needsYou = await readConsultantNeedsYou(consultantProfileId, now).catch(
    (error) => {
      reportSentryError(error, { subsystem: "dashboard", expected: true });
      return undefined;
    },
  );

  const availableEarnings = earningsByStatus.reduce(
    (sum, group) =>
      sum +
      sumPaise(group._sum.consultantSharePaise) -
      sumPaise(group._sum.refundedShareAmount),
    0,
  );

  // toPlain — the plan rows carry the money extension's inspect symbol, so the
  // payload is plainified before it crosses the RSC→Client HydrationBoundary.
  return toPlain({
    appointments: transformedAppointments,
    orgSessions,
    responseRate,
    payoutSetup: {
      needed: payoutNeeded,
      href: payoutSettingsHref(consultantProfileId),
      // Server-only flag, so it rides the payload to word the row.
      livePayoutsEnabled: ENABLE_LIVE_PAYOUTS,
    },
    needsYou,
    sessionsDelivered,
    performanceSnapshot: {
      publishedRatingOneToOne: profile?.publishedRatingOneToOne ?? null,
      publishedRatingGroup: profile?.publishedRatingGroup ?? null,
      ratedClientsOneToOne: profile?.ratedClientsOneToOne ?? 0,
      ratedEventsGroup: profile?.ratedEventsGroup ?? 0,
    },
    financialSummary: { availableEarnings },
  }) as unknown as TConsultantDashboardResponse;
}
