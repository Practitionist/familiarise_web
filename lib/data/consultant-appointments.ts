/**
 * Shared read for the consultant Appointments list. #890
 *
 * Single source of truth for the appointment-list payload behind
 * `GET /api/scheduling/appointments`. Both that route and the consultant
 * Appointments server page call this directly so SSR hydration and the
 * client `useQuery` resolve identical payloads — the route wraps it in
 * `{ data }`, the prefetch returns it raw (matching
 * `fetchWithErrorHandling`'s `json.data` unwrap).
 *
 * Auth + `?orgScope=` resolution stay in the route; this function carries
 * no request/session coupling and is callable from a Server Component. The
 * route resolves the Scope and passes it through unflattened — projecting it
 * to a WHERE clause happens here, via the shared projector, so a caller can no
 * longer get the projection subtly wrong on its own (#674 defect 13).
 *
 * Serialization: appointment rows spread the money-`$extends` plan/payment
 * models (#780/#781 result extension carries an inspect symbol), so the
 * return is wrapped in `toPlain(...)` before it can cross the RSC→Client
 * HydrationBoundary. The route path (NextResponse.json) was always fine —
 * JSON drops symbols — so this only matters for the SSR prefetch. Dates
 * stay Dates.
 */

import { isStaffNonParty, publicRequester } from "@/lib/booking/list-selects";
import prisma from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";
import { RESCHEDULE_OPEN_STATUSES } from "@/lib/booking/transitions";
import { AppointmentsType, AppointmentStatus, Prisma } from "@prisma/client";
import { toPlain } from "@/lib/data/serialize";
import { exactKeysetBand } from "@/lib/db/exact-keyset";
import {
  bookingAnomalies,
  scheduleAnomalyReport,
} from "@/lib/appointments/report-anomalies";
import type { TAppointmentWithSeats } from "@/types/appointment";
import type { Scope } from "@/lib/api/scope/parse";
import { scopeToPlanHostWhere, scopeToWhereOrgId } from "@/lib/api/scope/parse";
import {
  CONSULTANT_APPOINTMENTS_PAGE,
  CONSULTANT_APPOINTMENTS_RECENT_CAP,
  CONSULTANT_APPOINTMENTS_RECENT_PAST,
  encodeAppointmentsCursor,
  type AppointmentsCursor,
  type ConsultantAppointmentsWindow,
} from "@/lib/appointments/window";

export interface GetConsultantAppointmentsArgs {
  type?: AppointmentsType;
  consultantProfileId?: string | null;
  consulteeProfileId?: string | null;
  userId?: string | null;
  statuses?: {
    consultation?: string;
    subscription?: string;
    webinar?: string;
    class?: string;
  };
  startDate?: string | null;
  endDate?: string | null;
  eventIds?: {
    webinarId?: string | null;
    classId?: string | null;
    consultationId?: string | null;
    subscriptionId?: string | null;
  };
  /// #674 org scope resolved upstream (`resolveOrgScope`). Required: this
  /// read spans every tenant when unfiltered, so the caller has to say which
  /// slice it means rather than inheriting one.
  scope: Scope;
  /** "recent" (default) is every live row, capped, plus the first page of
   * past rows; "older" is one further page of past rows behind "Load older".
   * Ignored when a date range or an event id already bounds the read. */
  window?: ConsultantAppointmentsWindow;
  /** "older" only: the last row of the previous page (null = after recent). */
  before?: AppointmentsCursor | null;
  now?: Date;
}

/** A page of the list plus where the next "older" page starts. */
export interface ConsultantAppointmentsPage {
  rows: ConsultantListAppointment[];
  /** Null once the past rows are exhausted (or the read is not windowed). */
  nextCursor: string | null;
}

/** A row still to happen or still to be placed: a session ending later, or none at all. */
const liveRowWhere = (now: Date): Prisma.AppointmentWhereInput => ({
  OR: [
    { occurrences: { some: { deletedAt: null, endsAt: { gte: now } } } },
    { occurrences: { none: { deletedAt: null } } },
  ],
});

/** The exact complement of live: it has sessions and every one has ended. */
const pastRowWhere = (now: Date): Prisma.AppointmentWhereInput => ({
  occurrences: {
    some: { deletedAt: null },
    none: { deletedAt: null, endsAt: { gte: now } },
  },
});

const NEWEST_FIRST = [{ createdAt: "desc" as const }, { id: "desc" as const }];

/** Rows after the cursor row, newest-created first, at the column's microseconds. */
async function olderThan(
  cursor: AppointmentsCursor,
): Promise<Prisma.AppointmentWhereInput> {
  const band = await exactKeysetBand("Appointment", "desc", {
    id: cursor.id,
    at: cursor.createdAt,
  });
  return {
    OR: [{ createdAt: { lt: band.boundary } }, { id: { in: band.ids } }],
  };
}

/**
 * Read the appointment list (sorted by first slot start time). Returns the
 * inner array (NOT wrapped in `{ data }`). Auth/scope checks are the
 * caller's responsibility.
 *
 * The consultant Appointments page calls this with just
 * `{ consultantProfileId, scope: { kind: "personal" } }` (the default
 * "personal" view); the route passes the full arg set parsed from the
 * request query string.
 */
/**
 * Plan-side users on this surface are projected down to `listUserSelect`;
 * the roster itself is not fetched here (#1554 — it lives on
 * AppointmentParticipant and no list consumer reads it).
 */
export type ConsultantListAppointment = TAppointmentWithSeats;

/** STAFF read the learner of a booking they are not a party to in the public shape. */
export function withPublicRequesterForStaff(
  row: ConsultantListAppointment,
  viewer: {
    role?: string | null;
    consulteeProfileId?: string | null;
    consultantProfileId?: string | null;
  },
) {
  const request = row.consultation ?? row.subscription;
  const hostProfileId =
    row.consultation?.consultationPlan.consultantProfile.id ??
    row.subscription?.subscriptionPlan.consultantProfile.id;
  const isParty =
    (!!request && request.requestedBy.id === viewer.consulteeProfileId) ||
    (!!hostProfileId && hostProfileId === viewer.consultantProfileId);
  if (!isStaffNonParty(viewer.role, isParty)) return row;
  return {
    ...row,
    consultation: row.consultation && {
      ...row.consultation,
      requestedBy: publicRequester(row.consultation.requestedBy),
    },
    subscription: row.subscription && {
      ...row.subscription,
      requestedBy: publicRequester(row.subscription.requestedBy),
    },
  };
}

export async function getConsultantAppointments(
  args: GetConsultantAppointmentsArgs,
): Promise<ConsultantListAppointment[]> {
  return (await readConsultantAppointmentsPage(args)).rows;
}

export async function readConsultantAppointmentsPage(
  args: GetConsultantAppointmentsArgs,
): Promise<ConsultantAppointmentsPage> {
  const {
    type,
    consultantProfileId,
    consulteeProfileId,
    userId,
    statuses,
    startDate,
    endDate,
    eventIds,
    scope,
    window = "recent",
    before = null,
    now = new Date(),
  } = args;

  // A consultant's delivery splits on the plan's host org (a sponsor tag on
  // the booking is a funding rail); a buyer's or attendee's view on the tag.
  const planHost = scopeToPlanHostWhere(scope);
  const whereClause: Prisma.AppointmentWhereInput = consultantProfileId
    ? {}
    : { ...scopeToWhereOrgId(scope) };

  const eventScoped = Boolean(
    eventIds?.webinarId ||
    eventIds?.classId ||
    eventIds?.consultationId ||
    eventIds?.subscriptionId,
  );
  // Every list read is bounded unless a date range or an event id already
  // narrows it. Unscheduled rows are live: they still need a decision.
  const windowed = !(startDate && endDate) && !eventScoped;

  // Date range filtering for appointments. This is the primary filter.
  // It looks for appointments where any of its slots overlap with the given date range.
  // Also includes appointments with no slots (they'll be shown but sorted to the end)
  if (startDate && endDate) {
    whereClause.OR = [
      // Appointments with slots overlapping the date range
      {
        occurrences: {
          some: {
            deletedAt: null,
            AND: [
              { startsAt: { lt: new Date(endDate) } },
              { endsAt: { gt: new Date(startDate) } },
            ],
          },
        },
      },
      // OR appointments with no live slots at all
      {
        occurrences: {
          none: { deletedAt: null },
        },
      },
    ];
  }

  const userFilterClauses: Prisma.AppointmentWhereInput[] = [];
  if (consultantProfileId) {
    userFilterClauses.push({
      OR: [
        {
          consultation: {
            consultationPlan: { consultantProfileId, ...planHost },
          },
        },
        {
          subscription: {
            subscriptionPlan: { consultantProfileId, ...planHost },
          },
        },
        {
          webinar: {
            webinarPlan: { consultantProfileId, ...planHost },
          },
        },
        {
          // Collaborated webinars (co-host, moderator, etc.)
          webinar: {
            webinarPlan: {
              ...planHost,
              collaborators: {
                some: {
                  consultantProfileId,
                  status: "ACCEPTED",
                },
              },
            },
          },
        },
        {
          class: {
            classPlan: { consultantProfileId, ...planHost },
          },
        },
        {
          // Collaborated classes (co-instructor, TA, etc.)
          class: {
            classPlan: {
              ...planHost,
              collaborators: {
                some: {
                  consultantProfileId,
                  status: "ACCEPTED",
                },
              },
            },
          },
        },
      ],
    });
  }

  if (consulteeProfileId) {
    userFilterClauses.push({
      OR: [
        {
          consultation: {
            requestedBy: { id: consulteeProfileId },
          },
        },
        {
          subscription: {
            requestedBy: { id: consulteeProfileId },
          },
        },
        {
          participants: {
            some: { ...liveParticipant(), user: { consulteeProfileId } },
          },
        },
      ],
    });
  }

  if (userId) {
    userFilterClauses.push({
      participants: { some: liveParticipant(userId) },
    });
  }

  if (userFilterClauses.length > 0) {
    whereClause.AND = userFilterClauses;
  }

  if (type) {
    whereClause.appointmentType = type;
  }

  // Filter by specific event IDs
  if (eventIds?.webinarId) {
    whereClause.webinar = { id: eventIds.webinarId };
  }
  if (eventIds?.classId) {
    whereClause.class = { id: eventIds.classId };
  }
  if (eventIds?.consultationId) {
    whereClause.consultation = { id: eventIds.consultationId };
  }
  if (eventIds?.subscriptionId) {
    whereClause.subscription = { id: eventIds.subscriptionId };
  }

  // FIX #551: Apply status filters that were previously parsed but never used.
  // Build an OR clause so appointments matching ANY of the provided status
  // filters are returned (allows fetching e.g., APPROVED consultations AND
  // SCHEDULED webinars in one call).
  const statusFilters: Prisma.AppointmentWhereInput[] = [];
  if (statuses?.consultation) {
    statusFilters.push({
      consultation: { status: statuses.consultation as AppointmentStatus },
    });
  }
  if (statuses?.subscription) {
    statusFilters.push({
      subscription: { status: statuses.subscription as AppointmentStatus },
    });
  }
  if (statuses?.webinar) {
    statusFilters.push({
      webinar: { status: statuses.webinar as Prisma.EnumWebinarStatusFilter },
    });
  }
  if (statuses?.class) {
    statusFilters.push({
      class: { status: statuses.class as Prisma.EnumClassStatusFilter },
    });
  }
  if (statusFilters.length > 0) {
    // Combine with existing AND clauses
    const existingAnd = whereClause.AND
      ? Array.isArray(whereClause.AND)
        ? whereClause.AND
        : [whereClause.AND]
      : [];
    whereClause.AND = [...existingAnd, { OR: statusFilters }];
  }

  const listUserSelect = {
    id: true,
    name: true,
    email: true,
    image: true,
  } as const;

  // Host and co-host rows render name and image only, so no email is selected.
  const hostUserSelect = { id: true, name: true, image: true } as const;

  const include = {
    // Live buyer seats gate the host's Timings action on a webinar or class.
    _count: {
      select: {
        participants: { where: { ...liveParticipant(), role: "CONSULTEE" } },
      },
    },
    occurrences: {
      where: { deletedAt: null },
      orderBy: { startsAt: "asc" },
      include: {
        meeting: {
          select: { id: true, endedAt: true, endedReason: true },
        },
      },
    },
    // The open move, so a booking being rescheduled reads "Being moved" here too.
    rescheduleRequests: {
      where: { status: { in: RESCHEDULE_OPEN_STATUSES } },
      orderBy: { createdAt: "desc" },
      take: 1,
      select: {
        id: true,
        status: true,
        reason: true,
        expiresAt: true,
        originStatus: true,
        initiatorRole: true,
        initiatedById: true,
        proposedTimes: {
          orderBy: { startsAt: "asc" },
          take: 1,
          select: { startsAt: true, endsAt: true },
        },
      },
    },
    // The newest payment rows, so a pay-first hold reads its own pay window
    // (a 1:1 or plan has one buyer; a host's event view does not read them).
    payment: {
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 3,
      select: {
        id: true,
        paymentStatus: true,
        expiresAt: true,
        amount: true,
        currency: true,
        createdAt: true,
      },
    },
    consultation: {
      include: {
        consultationPlan: {
          include: {
            consultantProfile: {
              select: {
                id: true,
                userId: true,
                user: { select: hostUserSelect },
              },
            },
          },
        },
        requestedBy: {
          include: {
            user: { select: listUserSelect },
          },
        },
      },
    },
    subscription: {
      select: {
        id: true,
        subscriptionPlan: {
          include: {
            consultantProfile: {
              select: {
                id: true,
                userId: true,
                user: { select: hostUserSelect },
              },
            },
          },
        },
        requestedBy: {
          include: {
            user: { select: listUserSelect },
          },
        },
        schedulingPeriodStartsAt: true,
        schedulingPeriodEndsAt: true,
        // The allocate grid's entitlement clamps its cycle to the plan end.
        planEndsAt: true,
        schedulingTimezone: true,
        // #1766 — the allocate grid's cycle heading reads the frozen entitlement.
        sessionsTotal: true,
        sessionsPerWeek: true,
        sessionsRefunded: true,
        status: true,
      },
    },
    webinar: {
      include: {
        webinarPlan: {
          include: {
            consultantProfile: {
              select: {
                id: true,
                userId: true,
                user: { select: hostUserSelect },
              },
            },
            collaborators: {
              where: { status: "ACCEPTED" },
              include: {
                consultantProfile: {
                  select: {
                    id: true,
                    userId: true,
                    user: {
                      select: {
                        id: true,
                        name: true,
                        image: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    class: {
      include: {
        classPlan: {
          include: {
            consultantProfile: {
              select: {
                id: true,
                userId: true,
                user: { select: hostUserSelect },
              },
            },
            collaborators: {
              where: { status: "ACCEPTED" },
              include: {
                consultantProfile: {
                  select: {
                    id: true,
                    userId: true,
                    user: {
                      select: {
                        id: true,
                        name: true,
                        image: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  } satisfies Prisma.AppointmentInclude;
  const find = (where: Prisma.AppointmentWhereInput, page?: { take: number }) =>
    prisma.appointment.findMany({
      where,
      include,
      relationLoadStrategy: "join",
      ...(page && { orderBy: NEWEST_FIRST, take: page.take }),
    });

  let appointments: Awaited<ReturnType<typeof find>> = [];
  let nextCursor: string | null = null;
  // The next cursor comes from the last row in keyset order, before the
  // display sort below reorders the page by session time.
  const pastPage = async (cursor: AppointmentsCursor | null, take: number) => {
    const rows = await find(
      {
        AND: [
          whereClause,
          pastRowWhere(now),
          ...(cursor ? [await olderThan(cursor)] : []),
        ],
      },
      { take },
    );
    const last = rows[rows.length - 1];
    nextCursor =
      rows.length === take && last ? encodeAppointmentsCursor(last) : null;
    return rows;
  };
  if (!windowed) {
    appointments = await find(whereClause);
  } else if (window === "recent") {
    const live = await find(
      { AND: [whereClause, liveRowWhere(now)] },
      { take: CONSULTANT_APPOINTMENTS_RECENT_CAP },
    );
    const past = await pastPage(null, CONSULTANT_APPOINTMENTS_RECENT_PAST);
    appointments = [...live, ...past];
  } else {
    // The first "older" page starts after the recent read's past rows.
    const anchor =
      before ??
      (
        await prisma.appointment.findMany({
          where: { AND: [whereClause, pastRowWhere(now)] },
          select: { id: true, createdAt: true },
          orderBy: NEWEST_FIRST,
          skip: CONSULTANT_APPOINTMENTS_RECENT_PAST - 1,
          take: 1,
        })
      )[0] ??
      null;
    appointments = anchor
      ? await pastPage(anchor, CONSULTANT_APPOINTMENTS_PAGE)
      : [];
  }

  // Sort appointments by slot start time
  // Include appointments with 0 slots (push them to the end)
  const sorted = appointments.sort((a, b) => {
    const aTime = a.occurrences?.[0]?.startsAt;
    const bTime = b.occurrences?.[0]?.startsAt;

    // Appointments without slots go to the end
    if (!aTime && !bTime) return 0;
    if (!aTime) return 1;
    if (!bTime) return -1;

    return new Date(aTime).getTime() - new Date(bTime).getTime();
  });

  // Impossible session times on this page: one standing finding per row per day.
  scheduleAnomalyReport(bookingAnomalies(sorted), "consultant-appointments");

  // toPlain — rows spread the money-extended plan/payment models (#780/#781
  // result extension carries an inspect symbol), so the payload must be
  // plainified before it crosses the RSC→Client HydrationBoundary. Preserves
  // Dates as Dates. No-op for the route path (JSON drops symbols).
  return {
    rows: toPlain(sorted) as unknown as ConsultantListAppointment[],
    nextCursor,
  };
}
