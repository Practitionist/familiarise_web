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
import { liveParticipant } from "@/lib/booking/participants";
import {
  PERSONAL_PLAN_HOST,
  READABLE_ORG_PLAN_HOST,
} from "@/lib/api/scope/parse";
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
import {
  FIRST_RUN_PROFILE_SELECT,
  FIRST_RUN_USER_SELECT,
  readFirstRunSteps,
} from "@/lib/data/consultant-first-run";
import { readLatestReview } from "@/lib/reviews-latest";
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

/** The "Organisation sessions" strip shows the next few, not the book. */
const HOME_ORG_SESSIONS_TAKE = 5;

/**
 * Home splits delivery on the plan's host org: personal is every session on a
 * plan no org hosts (sponsor-funded ones included, money as metadata only);
 * the "Organisation sessions" strip is the org-hosted rest, trials included.
 */

const consultantAppointmentScope = (consultantProfileId: string) =>
  ({
    OR: [
      ...consultantDeliveryArms(consultantProfileId, PERSONAL_PLAN_HOST),
      {
        trial: {
          consultantProfileId,
          status: "SCHEDULED" as const,
          subscriptionPlan: PERSONAL_PLAN_HOST,
        },
      },
    ],
  }) satisfies Prisma.AppointmentWhereInput;

/** Org-hosted sessions this consultant must still show up for; metadata only (ADR 20). */
const consultantOrgAppointmentScope = (consultantProfileId: string) =>
  ({
    OR: [
      ...consultantDeliveryArms(consultantProfileId, READABLE_ORG_PLAN_HOST),
      {
        trial: {
          consultantProfileId,
          status: "SCHEDULED" as const,
          subscriptionPlan: READABLE_ORG_PLAN_HOST,
        },
      },
    ],
  }) satisfies Prisma.AppointmentWhereInput;

const HOST_ORG = { select: { id: true, name: true } } as const;
/** The org hosting the delivered plan, whichever kind it is. */
const HOST_ORG_SELECT = {
  consultation: {
    select: { consultationPlan: { select: { organization: HOST_ORG } } },
  },
  subscription: {
    select: { subscriptionPlan: { select: { organization: HOST_ORG } } },
  },
  webinar: { select: { webinarPlan: { select: { organization: HOST_ORG } } } },
  trial: {
    select: { subscriptionPlan: { select: { organization: HOST_ORG } } },
  },
  class: { select: { classPlan: { select: { organization: HOST_ORG } } } },
} satisfies Prisma.AppointmentSelect;

type HostOrg = { id: string; name: string } | null;
function hostOrgOf(a: {
  consultation: { consultationPlan: { organization: HostOrg } } | null;
  subscription: { subscriptionPlan: { organization: HostOrg } } | null;
  webinar: { webinarPlan: { organization: HostOrg } } | null;
  class: { classPlan: { organization: HostOrg } } | null;
  trial: { subscriptionPlan: { organization: HostOrg } } | null;
}): HostOrg {
  return (
    a.consultation?.consultationPlan.organization ??
    a.subscription?.subscriptionPlan.organization ??
    a.webinar?.webinarPlan.organization ??
    a.class?.classPlan.organization ??
    a.trial?.subscriptionPlan.organization ??
    null
  );
}

/** Home lists the next few sessions booked as a client, not the history. */
const HOME_CLIENT_BOOKINGS_TAKE = 5;

const EXPERT_NAME = {
  select: {
    consultantProfile: { select: { user: { select: { name: true } } } },
  },
} as const;
const CLIENT_EXPERT_SELECT = {
  consultation: { select: { consultationPlan: EXPERT_NAME } },
  subscription: { select: { subscriptionPlan: EXPERT_NAME } },
  webinar: { select: { webinarPlan: EXPERT_NAME } },
  class: { select: { classPlan: EXPERT_NAME } },
} satisfies Prisma.AppointmentSelect;

type PlanExpert = {
  consultantProfile: { user: { name: string | null } } | null;
};
function expertNameOf(a: {
  consultation: { consultationPlan: PlanExpert } | null;
  subscription: { subscriptionPlan: PlanExpert } | null;
  webinar: { webinarPlan: PlanExpert } | null;
  class: { classPlan: PlanExpert } | null;
}): string | null {
  const plan =
    a.consultation?.consultationPlan ??
    a.subscription?.subscriptionPlan ??
    a.webinar?.webinarPlan ??
    a.class?.classPlan;
  return plan?.consultantProfile?.user.name ?? null;
}

/** A webinar or class still to deliver, as the other live-event readers count it. */
const LIVE_EVENT = { in: ["SCHEDULED" as const, "IN_PROGRESS" as const] };

const consultantDeliveryArms = (
  consultantProfileId: string,
  planHost: typeof PERSONAL_PLAN_HOST | typeof READABLE_ORG_PLAN_HOST,
): Prisma.AppointmentWhereInput[] => [
  {
    consultation: {
      consultationPlan: { consultantProfileId, ...planHost },
      status: "APPROVED" as const,
    },
  },
  {
    subscription: {
      subscriptionPlan: { consultantProfileId, ...planHost },
      status: "APPROVED" as const,
    },
  },
  {
    webinar: {
      webinarPlan: { consultantProfileId, ...planHost },
      status: LIVE_EVENT,
    },
  },
  {
    // Collaborated webinars (co-host, moderator, etc.)
    webinar: {
      webinarPlan: {
        ...planHost,
        collaborators: {
          some: { consultantProfileId, status: "ACCEPTED" as const },
        },
      },
      status: LIVE_EVENT,
    },
  },
  {
    class: {
      classPlan: { consultantProfileId, ...planHost },
      status: LIVE_EVENT,
    },
  },
  {
    // Collaborated classes (co-instructor, TA, etc.)
    class: {
      classPlan: {
        ...planHost,
        collaborators: {
          some: { consultantProfileId, status: "ACCEPTED" as const },
        },
      },
      status: LIVE_EVENT,
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
      sessionsPerWeek: true,
      sessionsRefunded: true,
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
): { startOfToday: Date; startOfMonth: Date; startOfLastMonth: Date } {
  const day = formatInTimeZone(now, zone, "yyyy-MM-dd");
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const lastMonth =
    month === 1
      ? `${year - 1}-12`
      : `${year}-${String(month - 1).padStart(2, "0")}`;
  return {
    startOfToday: fromZonedTime(`${day}T00:00:00`, zone),
    startOfMonth: fromZonedTime(`${day.slice(0, 7)}-01T00:00:00`, zone),
    startOfLastMonth: fromZonedTime(`${lastMonth}-01T00:00:00`, zone),
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
      userId: true,
      ...FIRST_RUN_PROFILE_SELECT,
      user: {
        select: {
          timezone: true,
          consulteeProfileId: true,
          ...FIRST_RUN_USER_SELECT,
        },
      },
    },
  });
  const firstRunSteps = profile
    ? readFirstRunSteps(profile, consultantProfileId)
    : null;
  const zone = resolveViewerZone({ userTimezone: profile?.user.timezone });
  const { startOfToday, startOfMonth, startOfLastMonth } = homeBoundaries(
    now,
    zone,
  );

  // Which appointments Home shows: Appointment has no start column, so rank
  // on the slot table (indexed on startsAt, endsAt) and keep the soonest ids.
  // Anchored on endsAt >= start of today so a session running now survives.
  const [soonestSlots, orgSessionRows, earningsByStatus, clientRows] =
    await runBounded([
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
            appointment: { select: HOST_ORG_SELECT },
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
      // Sessions this consultant booked as a client with another expert: the
      // same seat arm the public grid paints busy, shown read-only on Home.
      () =>
        profile
          ? prisma.appointmentOccurrence.findMany({
              where: {
                deletedAt: null,
                completionStatus: "SCHEDULED",
                isTentative: false,
                endsAt: { gte: startOfToday },
                appointment: {
                  deletedAt: null,
                  participants: {
                    some: {
                      ...liveParticipant(profile.userId),
                      role: "CONSULTEE",
                    },
                  },
                },
              },
              select: {
                id: true,
                appointmentId: true,
                startsAt: true,
                endsAt: true,
                appointment: { select: CLIENT_EXPERT_SELECT },
              },
              orderBy: { startsAt: "asc" },
              take: HOME_CLIENT_BOOKINGS_TAKE,
              relationLoadStrategy: "join",
            })
          : Promise.resolve([]),
    ] as const);
  const homeAppointmentIds = [
    ...new Set(soonestSlots.map((s) => s.appointmentId)),
  ].slice(0, HOME_APPOINTMENTS_TAKE);
  const learnerId = profile?.user.consulteeProfileId ?? null;
  const clientBookings = clientRows.map((row) => ({
    occurrenceId: row.id,
    appointmentId: row.appointmentId,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    expertName: expertNameOf(row.appointment) ?? "another expert",
    href: learnerId
      ? `/dashboard/consultee/${learnerId}/appointments/${row.appointmentId}`
      : null,
  }));
  const orgSessions = orgSessionRows.map((row) => ({
    occurrenceId: row.id,
    appointmentId: row.appointmentId,
    organizationId: hostOrgOf(row.appointment)?.id ?? "",
    organizationName: hostOrgOf(row.appointment)?.name ?? "Organisation",
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
  const sortedAppointments = appointmentsRaw.toSorted((a, b) => {
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
            sessionsPerWeek: appointment.subscription.sessionsPerWeek,
            sessionsRefunded: appointment.subscription.sessionsRefunded,
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
  const [responseRate, sessionsDelivered, payoutNeeded, latestReview] =
    await runBounded([
      () => getConsultantResponseRate(consultantProfileId, now),
      () =>
        readSessionsDelivered(
          consultantProfileId,
          startOfMonth,
          startOfLastMonth,
        ).catch(() => undefined),
      () =>
        readPayoutSetupNeeded(consultantProfileId).catch((error) => {
          reportSentryError(error, { subsystem: "payments", expected: true });
          return false;
        }),
      () =>
        readLatestReview(consultantProfileId).catch((error) => {
          reportSentryError(error, { subsystem: "dashboard", expected: true });
          return null;
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
    clientBookings,
    responseRate,
    payoutSetup: {
      needed: payoutNeeded,
      href: payoutSettingsHref(consultantProfileId),
      // Server-only flag, so it rides the payload to word the row.
      livePayoutsEnabled: ENABLE_LIVE_PAYOUTS,
    },
    needsYou,
    sessionsDelivered,
    ...(latestReview ? { latestReview } : {}),
    ...(firstRunSteps ? { firstRun: { steps: firstRunSteps } } : {}),
    performanceSnapshot: {
      publishedRatingOneToOne: profile?.publishedRatingOneToOne ?? null,
      publishedRatingGroup: profile?.publishedRatingGroup ?? null,
      ratedClientsOneToOne: profile?.ratedClientsOneToOne ?? 0,
      ratedEventsGroup: profile?.ratedEventsGroup ?? 0,
    },
    financialSummary: { availableEarnings },
  }) as unknown as TConsultantDashboardResponse;
}
