/**
 * Shared list-appointments query for the personal-vs-org-scope split
 * (#674 / B1-hybrid). One query, two routes:
 *
 *   - `/api/appointments?orgScope=...` — personal endpoint (auth: any
 *     signed-in user; defaults `personal`).
 *   - `/api/organizations/[orgId]/appointments` — org-scoped endpoint
 *     (auth: MANAGER+ at the org; scope is forced to `org:<orgId>`).
 *
 * Both routes call `listAppointmentsScoped` with the resolved Scope
 * and the same filters. The shape returned is identical so the same
 * client table component can render either source.
 *
 * Auth is enforced UPSTREAM in each route handler (`requireOrgAccess`
 * for the org route, session presence for the personal route). This
 * function trusts its caller — pass it the resolved Scope only after
 * `resolveOrgScope` returned `ok`.
 */

import prisma from "@/lib/prisma";
import {
  liveParticipant,
  NOT_COLLABORATOR_ROW,
} from "@/lib/booking/participants";
import { ORG_FUNDED_PAYMENT_METHODS } from "@/lib/payments/org-funded";
import { RESCHEDULE_OPEN_STATUSES } from "@/lib/booking/transitions";
import { readOrgOwnerUserIds } from "@/lib/enterprise/related-party";
import type { AppointmentsType, Prisma } from "@prisma/client";
import type { Scope } from "./parse";
import { assertNeverScope, ORG_SCOPE_READABLE_STATUSES } from "./parse";

/** Live sessions a list row carries; the rest are counted, not loaded. */
const LIST_UPCOMING_OCCURRENCES = 3;

/** Join state needs the slot id, times, tombstone and the call's end. */
const LIST_OCCURRENCE_SELECT = {
  id: true,
  startsAt: true,
  endsAt: true,
  isTentative: true,
  completionStatus: true,
  outcome: true,
  deletedAt: true,
  meeting: { select: { endedAt: true, endedReason: true } },
} satisfies Prisma.AppointmentOccurrenceSelect;

export interface ListAppointmentsParams {
  scope: Scope;
  /** The session user's id. Used as the personal-scope filter root. */
  userId: string;
  /** Optional appointmentType filter (CONSULTATION/SUBSCRIPTION/...). */
  appointmentType?: AppointmentsType;
  /** Pagination — 1-indexed page, default 20 items per page. */
  page?: number;
  perPage?: number;
  /** Narrows the scoped set further (e.g. suspended members' sessions). */
  extraWhere?: Prisma.AppointmentWhereInput;
  now?: Date;
}

export interface ListAppointmentsResult {
  items: Awaited<ReturnType<typeof prisma.appointment.findMany>>;
  total: number;
  page: number;
  perPage: number;
}

/**
 * Build the Prisma `where` clause for the requested scope.
 *
 *   - `personal`: the user's B2C rows. Booked or attended (consultee side) when
 *     the booking carries no org tag; delivered (consultant side) when the plan
 *     has no host org, whatever sponsor tag the booking carries.
 *   - `orgMember`: one member's rows within the org, split the same way: booked
 *     or attended when tagged to this org, delivered when this org hosts the plan.
 *   - `org`: rows tagged to this org on a ground the org owns (unpaid, paid
 *     from this org's money, or delivered on its plan), while it is readable.
 *     No user filter; MANAGER+ sees the org's activity.
 *   - `all`: no scope filter; admin-only.
 */
function deliveredArms(
  uid: string,
  planHost: { organizationId: string | null },
): Prisma.AppointmentWhereInput[] {
  const acceptedCoHost = {
    collaborators: {
      some: { consultantProfile: { userId: uid }, status: "ACCEPTED" as const },
    },
  };
  return [
    {
      consultation: {
        consultationPlan: { ...planHost, consultantProfile: { userId: uid } },
      },
    },
    {
      subscription: {
        subscriptionPlan: { ...planHost, consultantProfile: { userId: uid } },
      },
    },
    {
      webinar: {
        webinarPlan: { ...planHost, consultantProfile: { userId: uid } },
      },
    },
    { webinar: { webinarPlan: { ...planHost, ...acceptedCoHost } } },
    {
      class: { classPlan: { ...planHost, consultantProfile: { userId: uid } } },
    },
    { class: { classPlan: { ...planHost, ...acceptedCoHost } } },
  ];
}

/** Booked as the buyer or holding a live seat (webinar/class attendee). */
function attendedArms(uid: string): Prisma.AppointmentWhereInput[] {
  return [
    { consultation: { requestedBy: { userId: uid } } },
    { subscription: { requestedBy: { userId: uid } } },
    {
      participants: {
        some: { ...liveParticipant(uid), ...NOT_COLLABORATOR_ROW },
      },
    },
  ];
}

/**
 * Rows an org owns, only while it is readable: tagged to the org AND unpaid
 * or paid from this org's money (WALLET/INVOICE/LICENSE), OR delivered on a
 * plan the org hosts, whatever the buyer's tag or rail. A tagged card-paid
 * booking on someone else's plan is not the org's. Org lists stay
 * metadata-only. Every org-side read of bookings (lists, queues, documents,
 * recordings, detail and access grants) uses it.
 */
export function orgOwnedAppointmentWhere(
  orgId: string,
): Prisma.AppointmentWhereInput {
  const hostedHere = {
    organizationId: orgId,
    organization: { is: { status: { in: ORG_SCOPE_READABLE_STATUSES } } },
  };
  return {
    OR: [
      {
        organizationId: orgId,
        organization: { is: { status: { in: ORG_SCOPE_READABLE_STATUSES } } },
        OR: [
          { payment: { none: {} } },
          {
            payment: {
              some: {
                organizationId: orgId,
                paymentMethod: { in: ORG_FUNDED_PAYMENT_METHODS },
              },
            },
          },
        ],
      },
      { consultation: { consultationPlan: hostedHere } },
      { subscription: { subscriptionPlan: hostedHere } },
      { webinar: { webinarPlan: hostedHere } },
      { class: { classPlan: hostedHere } },
    ],
  };
}

export function buildWhere(
  params: ListAppointmentsParams,
): Prisma.AppointmentWhereInput {
  const base: Prisma.AppointmentWhereInput = {
    // #1583 D-P1-06 — a tombstoned appointment (a cancelled trial's held
    // call) is not a listing.
    deletedAt: null,
    ...(params.appointmentType && {
      appointmentType: params.appointmentType,
    }),
  };

  if (params.scope.kind === "personal") {
    const uid = params.userId;
    return {
      ...base,
      OR: [
        { organizationId: null, OR: attendedArms(uid) },
        // A trial is always personal for the learner; delivery splits on the
        // subscription plan's host org like every request.
        { trial: { consulteeProfile: { userId: uid } } },
        {
          trial: {
            consultantProfile: { userId: uid },
            subscriptionPlan: { organizationId: null },
          },
        },
        ...deliveredArms(uid, { organizationId: null }),
      ],
    };
  }

  if (params.scope.kind === "orgMember") {
    // A trial is personal for the learner, so only the delivered arm appears.
    const uid = params.scope.userId;
    const orgId = params.scope.orgId;
    return {
      ...base,
      OR: [
        { organizationId: orgId, OR: attendedArms(uid) },
        {
          trial: {
            consultantProfile: { userId: uid },
            subscriptionPlan: { organizationId: orgId },
          },
        },
        ...deliveredArms(uid, { organizationId: orgId }),
      ],
    };
  }

  if (params.scope.kind === "org") {
    return { ...base, ...orgOwnedAppointmentWhere(params.scope.orgId) };
  }

  // Explicit rather than a fall-through: `base` alone is the admin/staff arm,
  // so an unhandled kind reaching it would return every tenant's rows.
  if (params.scope.kind === "all") return base;

  return assertNeverScope(params.scope);
}

export async function listAppointmentsScoped(
  params: ListAppointmentsParams,
): Promise<ListAppointmentsResult> {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(100, Math.max(1, params.perPage ?? 20));
  const now = params.now ?? new Date();
  const scoped = buildWhere(params);
  const where = params.extraWhere
    ? { AND: [scoped, params.extraWhere] }
    : scoped;

  const [total, items] = await prisma.$transaction([
    prisma.appointment.count({ where }),
    prisma.appointment.findMany({
      where,
      include: {
        // Who from the VIEWING org was funded into this session.
        //
        // Scoped to `scope.orgId` and nothing else, which is the whole point: a
        // webinar's registrants may span several sponsors and the public, and a
        // sponsor is entitled to see the five people it paid for — not the
        // twenty it did not. Empty for 1:1 kinds, where `getMember` already
        // names the counterpart, and empty for a hosted-but-not-funded event.
        //
        // The paymentMethod clause mirrors the WHERE above rather than repeating
        // the reasoning: a payer card row merely tagged to this org is not this
        // org's money, so it must not be presented as a seat this org bought.
        ...(params.scope.kind === "org"
          ? {
              payment: {
                where: {
                  organizationId: params.scope.orgId,
                  paymentMethod: { in: ORG_FUNDED_PAYMENT_METHODS },
                },
                select: {
                  id: true,
                  user: { select: { id: true, name: true, email: true } },
                },
              },
            }
          : {}),
        // The next few live sessions (Join and the displayed time) plus a
        // count; a fully past row gets its latest session below instead.
        occurrences: {
          where: { deletedAt: null, endsAt: { gte: now } },
          select: LIST_OCCURRENCE_SELECT,
          orderBy: { startsAt: "asc" },
          take: LIST_UPCOMING_OCCURRENCES,
        },
        // Settled charges, so a paid plan waiting for its times is not read as
        // unpaid; joined into the same statement.
        _count: {
          select: {
            occurrences: { where: { deletedAt: null } },
            payment: { where: { paymentStatus: "SUCCEEDED", deletedAt: null } },
          },
        },
        // The open move, so a booking being rescheduled reads "Being moved".
        rescheduleRequests: {
          where: { status: { in: RESCHEDULE_OPEN_STATUSES } },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { initiatorRole: true, expiresAt: true, originStatus: true },
        },
        consultation: {
          select: {
            status: true,
            bookingSource: true,
            consultationPlan: {
              select: {
                title: true,
                consultantProfile: {
                  select: {
                    user: { select: { id: true, name: true, email: true } },
                  },
                },
              },
            },
            requestedBy: {
              select: {
                user: { select: { id: true, name: true, email: true } },
              },
            },
          },
        },
        subscription: {
          select: {
            status: true,
            bookingSource: true,
            subscriptionPlan: {
              select: {
                title: true,
                consultantProfile: {
                  select: {
                    user: { select: { id: true, name: true, email: true } },
                  },
                },
              },
            },
            requestedBy: {
              select: {
                user: { select: { id: true, name: true, email: true } },
              },
            },
          },
        },
        webinar: {
          select: {
            status: true,
            webinarPlan: {
              select: {
                title: true,
                consultantProfile: {
                  select: {
                    user: { select: { id: true, name: true, email: true } },
                  },
                },
              },
            },
          },
        },
        class: {
          select: {
            status: true,
            classPlan: {
              select: {
                title: true,
                consultantProfile: {
                  select: {
                    user: { select: { id: true, name: true, email: true } },
                  },
                },
              },
            },
          },
        },
        trial: {
          select: {
            status: true,
            consulteeProfile: {
              select: {
                user: { select: { id: true, name: true, email: true } },
              },
            },
            consultantProfile: {
              select: {
                user: { select: { id: true, name: true, email: true } },
              },
            },
          },
        },
        organization: { select: { id: true, name: true, slug: true } },
      },
      orderBy: { createdAt: "desc" },
      take: perPage,
      skip: (page - 1) * perPage,
      relationLoadStrategy: "join",
    }),
  ]);

  const owners =
    params.scope.kind === "org"
      ? await readOrgOwnerUserIds(prisma, params.scope.orgId)
      : null;
  const pastIds = items
    .filter((a) => a.occurrences.length === 0 && a._count.occurrences > 0)
    .map((a) => a.id);
  const latest =
    pastIds.length === 0
      ? []
      : await prisma.appointment.findMany({
          where: { id: { in: pastIds } },
          select: {
            id: true,
            occurrences: {
              where: { deletedAt: null },
              select: LIST_OCCURRENCE_SELECT,
              orderBy: { startsAt: "desc" },
              take: 1,
            },
          },
          relationLoadStrategy: "join",
        });
  const latestById = new Map(latest.map((a) => [a.id, a.occurrences]));
  return {
    items: items.map((a) => {
      const expertUserId = (
        a.consultation?.consultationPlan ??
        a.subscription?.subscriptionPlan ??
        a.webinar?.webinarPlan ??
        a.class?.classPlan
      )?.consultantProfile?.user.id;
      return {
        ...a,
        occurrences: latestById.get(a.id) ?? a.occurrences,
        // Org lists flag sessions an OWNER of this org delivered on its money
        // (the `payment` include is already this org's funded rails only).
        relatedParty:
          !!owners &&
          !!expertUserId &&
          owners.has(expertUserId) &&
          "payment" in a &&
          Array.isArray(a.payment) &&
          a.payment.length > 0,
      };
    }),
    total,
    page,
    perPage,
  };
}
