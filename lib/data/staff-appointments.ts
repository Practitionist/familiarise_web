/**
 * The staff appointments table, shared by GET /api/staff/appointments and the
 * page's SSR prefetch so both resolve the same JSON-safe payload. Auth stays at
 * the call site.
 */

import { withLapsedMoveRestored } from "@/lib/appointments/lapsed-move";
import prisma from "@/lib/prisma";
import { RESCHEDULE_OPEN_STATUSES } from "@/lib/booking/transitions";
import { AppointmentsType, Prisma } from "@prisma/client";
import { z } from "zod";
import { toPlain } from "@/lib/data/serialize";
import type { Scope } from "@/lib/api/scope/parse";
import { scopeToWhereOrgId } from "@/lib/api/scope/parse";
import {
  APPOINTMENT_HEADLINE_SELECT,
  appointmentHeadline,
  headlineUserIds,
  trialPricePaise,
} from "@/lib/data/appointment-headline";
import type {
  StaffAppointmentsPayload,
  StaffAppointmentType,
  STAFF_ISSUE_TYPES,
} from "@/lib/data/staff-appointments-schema";

type StaffIssueType = (typeof STAFF_ISSUE_TYPES)[number];

const STAFF_TYPE: Record<AppointmentsType, StaffAppointmentType> = {
  CONSULTATION: "consultation",
  SUBSCRIPTION: "subscription",
  WEBINAR: "webinar",
  CLASS: "class",
  TRIAL: "trial",
};

export type StaffAppointmentsParams = {
  type?: string | null;
  status?: string | null;
  search?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  /**
   * #674 defect 13 — required, not optional. This surface reads EVERY tenant
   * by default, so "no scope passed" and "the operator deliberately wants the
   * platform view" used to look identical at the call site. Naming
   * `{ kind: "all" }` makes that a decision someone wrote down.
   */
  scope: Scope;
  page?: number;
  limit?: number;
};

/** A trial priced above zero, at request or (rows from before the column) on its plan. */
const PRICED_TRIAL = {
  OR: [
    { agreedPricePaise: { gt: 0 } },
    {
      agreedPricePaise: null,
      subscriptionPlan: { trialPriceInPaise: { gt: 0 } },
    },
  ],
} satisfies Prisma.TrialWhereInput;

/**
 * The staff tabs (scheduled / completed / issue) as a DB condition across the
 * five booking kinds, so filtering and tab counts run in the query. "issue"
 * mirrors the row's `hasIssue`: removed, cancelled (a trial wrapper whose trial
 * row is gone reads cancelled), or unpaid while not a pending request.
 * Returns null for "all" or an unknown tab.
 */
export function buildStatusWhere(
  status: string | null,
): Prisma.AppointmentWhereInput | null {
  if (status === "scheduled") {
    // A confirmed 1:1 or plan is stored APPROVED; events and trials are SCHEDULED.
    return {
      OR: [
        { consultation: { status: "APPROVED" } },
        { subscription: { status: "APPROVED" } },
        { webinar: { status: "SCHEDULED" } },
        { class: { status: "SCHEDULED" } },
        { trial: { status: "SCHEDULED" } },
      ],
    };
  }
  if (status === "completed") {
    return {
      OR: [
        { consultation: { status: "COMPLETED" } },
        { subscription: { status: "COMPLETED" } },
        { webinar: { status: "COMPLETED" } },
        { class: { status: "COMPLETED" } },
        { trial: { status: { in: ["COMPLETED", "CONVERTED"] } } },
      ],
    };
  }
  if (status === "issue") {
    return {
      OR: [
        { deletedAt: { not: null } },
        { consultation: { status: "CANCELLED" } },
        { subscription: { status: "CANCELLED" } },
        { webinar: { status: "CANCELLED" } },
        { class: { status: "CANCELLED" } },
        { trial: { status: "CANCELLED" } },
        { appointmentType: "TRIAL", trial: { is: null } },
        {
          AND: [
            { payment: { none: {} } },
            {
              OR: [
                { consultation: { status: { not: "PENDING" } } },
                { subscription: { status: { not: "PENDING" } } },
                { webinarId: { not: null } },
                { classId: { not: null } },
                { trial: PRICED_TRIAL },
              ],
            },
          ],
        },
      ],
    };
  }
  return null;
}

/**
 * Fetch the staff appointments table as a JSON-safe payload.
 *
 * Single source of truth for both the route and the prefetch — the returned
 * object is the exact shape the client useQuery(["staff-appointments", ...])
 * caches. Date fields are pre-serialized to ISO strings here so the
 * SSR-dehydrated cache matches the client fetch verbatim.
 */
export async function getStaffAppointments(
  params: StaffAppointmentsParams,
): Promise<StaffAppointmentsPayload> {
  const type = z.nativeEnum(AppointmentsType).safeParse(params.type).data;
  const status = params.status ?? null;
  const search = params.search ?? null;
  const dateFrom = params.dateFrom ?? null;
  const dateTo = params.dateTo ?? null;
  // #674 comment 7 — org-scope filter for support staff drilling into a single
  // tenant's appointments. Uses Appointment.organizationId.
  const orgWhere = scopeToWhereOrgId(params.scope);
  const page = params.page ?? 1;
  const limit = params.limit ?? 20;
  const offset = (page - 1) * limit;

  // Base where (type / org / date / search) — NOT status. #897: status is a
  // derived value (per-type sub-entity status + payment presence), so it's
  // resolved to DB conditions and AND-ed in below, instead of post-filtering a
  // single page (which broke page sizes and totals).
  const baseWhere: Prisma.AppointmentWhereInput = { ...orgWhere };

  if (type) {
    baseWhere.appointmentType = type;
  }

  // One range predicate both filters the rows and picks the occurrence each row displays.
  // Both bounds share one `startsAt`: a second key would replace the first.
  const occurrenceInRange: Prisma.AppointmentOccurrenceWhereInput | undefined =
    dateFrom || dateTo
      ? {
          startsAt: {
            ...(dateFrom && { gte: new Date(dateFrom) }),
            ...(dateTo && { lte: new Date(dateTo) }),
          },
        }
      : undefined;
  if (occurrenceInRange) {
    baseWhere.occurrences = { some: occurrenceInRange };
  }

  // Handle search across multiple fields
  if (search) {
    const people = {
      OR: [
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ],
    } satisfies Prisma.UserWhereInput;
    baseWhere.OR = [
      { id: { contains: search, mode: "insensitive" } },
      // Consultation search
      {
        consultation: {
          consultationPlan: {
            title: { contains: search, mode: "insensitive" },
          },
        },
      },
      {
        consultation: {
          consultationPlan: {
            consultantProfile: {
              user: {
                OR: [
                  { name: { contains: search, mode: "insensitive" } },
                  { email: { contains: search, mode: "insensitive" } },
                ],
              },
            },
          },
        },
      },
      {
        consultation: {
          requestedBy: {
            user: {
              OR: [
                { name: { contains: search, mode: "insensitive" } },
                { email: { contains: search, mode: "insensitive" } },
              ],
            },
          },
        },
      },
      // Subscription search
      {
        subscription: {
          subscriptionPlan: {
            title: { contains: search, mode: "insensitive" },
          },
        },
      },
      // Webinar search
      {
        webinar: {
          webinarPlan: {
            title: { contains: search, mode: "insensitive" },
          },
        },
      },
      // Class search
      {
        class: {
          classPlan: {
            title: { contains: search, mode: "insensitive" },
          },
        },
      },
      // Trial search: its plan, its expert and its learner
      {
        trial: {
          subscriptionPlan: {
            title: { contains: search, mode: "insensitive" },
          },
        },
      },
      { trial: { consultantProfile: { user: people } } },
      { trial: { consulteeProfile: { user: people } } },
    ];
  }

  // #897 — AND the resolved status condition onto the base for the list query
  // so pagination + total reflect the filtered set.
  const statusCond = buildStatusWhere(status);
  const listWhere: Prisma.AppointmentWhereInput = statusCond
    ? { AND: [baseWhere, statusCond] }
    : baseWhere;

  // One paginated list query + per-tab count queries. `total` drives
  // pagination for the CURRENT view; the tab badges are global counts within
  // the base filter (not page-scoped), which is the #897 fix.
  const [
    appointments,
    total,
    allCount,
    scheduledCount,
    completedCount,
    issuesCount,
  ] = await Promise.all([
    prisma.appointment.findMany({
      relationLoadStrategy: "join",
      where: listWhere,
      select: {
        id: true,
        createdAt: true,
        ...APPOINTMENT_HEADLINE_SELECT,
        // #1486 / #1527 — read-only: a reschedule still waiting on a party.
        rescheduleRequests: {
          where: { status: { in: RESCHEDULE_OPEN_STATUSES } },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            status: true,
            initiatorRole: true,
            expiresAt: true,
            originStatus: true,
          },
        },
        occurrences: {
          where: occurrenceInRange,
          orderBy: { startsAt: "asc" },
          take: 1,
          select: {
            id: true,
            startsAt: true,
            endsAt: true,
            isTentative: true,
          },
        },
        payment: {
          select: {
            id: true,
            amount: true,
            currency: true,
            paymentStatus: true,
            paymentGateway: true,
            // The pay window, so a pending order past it reads as lapsed.
            expiresAt: true,
            createdAt: true,
          },
          take: 1,
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.appointment.count({ where: listWhere }),
    prisma.appointment.count({ where: baseWhere }),
    prisma.appointment.count({
      where: { AND: [baseWhere, buildStatusWhere("scheduled") ?? {}] },
    }),
    prisma.appointment.count({
      where: { AND: [baseWhere, buildStatusWhere("completed") ?? {}] },
    }),
    prisma.appointment.count({
      where: { AND: [baseWhere, buildStatusWhere("issue") ?? {}] },
    }),
  ]);

  // One batched user read for the page's people, not one per relation path.
  const userIds = headlineUserIds(appointments);
  const users =
    userIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, email: true, image: true },
        })
      : [];
  const usersById = new Map(users.map((u) => [u.id, u]));

  // Format appointments for frontend
  const now = new Date();
  const formattedAppointments = appointments.map((row) => {
    // A move past its deadline reads as the original until the sweep ends it.
    const apt = withLapsedMoveRestored(row, now);
    const headline = appointmentHeadline(apt, usersById);
    const consultant = headline.expert;
    const consultee = headline.attendeeLabel
      ? { id: "", name: headline.attendeeLabel, email: "", image: null }
      : headline.learner;
    const aptStatus = headline.lifecycleStatus;

    const slot = apt.occurrences[0];
    const payment = apt.payment[0];

    // A wrapper whose lifecycle row is gone (a trial re-requested by the pair)
    // has nothing live, so it reads cancelled rather than claiming a state.
    let displayStatus = "cancelled";
    if (aptStatus) {
      const statusStr = String(aptStatus).toLowerCase();
      if (statusStr === "cancelled") displayStatus = "cancelled";
      else if (statusStr === "completed") displayStatus = "completed";
      else if (statusStr === "in_progress") displayStatus = "in_progress";
      else if (statusStr === "scheduled") displayStatus = "scheduled";
      else displayStatus = statusStr;
    }

    // Free: a ₹0 payment, or no payment on a booking priced at zero.
    let free: boolean;
    if (payment) free = Number(payment.amount) === 0;
    else if (apt.trial) free = trialPricePaise(apt.trial) === 0;
    else
      free =
        Number(
          apt.consultation?.consultationPlan.price ??
            apt.subscription?.subscriptionPlan.price ??
            -1,
        ) === 0;
    // A removed booking is listed as removed, never hidden.
    const removed = apt.deletedAt !== null;
    const hasIssue =
      removed ||
      displayStatus === "cancelled" ||
      (!payment && !free && aptStatus !== "PENDING");
    let issueType: StaffIssueType | null = null;
    if (removed) issueType = "Removed";
    else if (displayStatus === "cancelled") issueType = "Cancelled";
    else if (hasIssue) issueType = "Payment pending";

    // Date→ISO so the payload is JSON-safe verbatim (matches NextResponse.json)
    const scheduledAtDate = slot?.startsAt || apt.createdAt;

    return {
      id: apt.id,
      type: STAFF_TYPE[apt.appointmentType],
      title: headline.title,
      consultant: consultant
        ? {
            id: consultant.id,
            name: consultant.name,
            email: consultant.email,
            avatar: consultant.image,
          }
        : null,
      consultee: consultee
        ? {
            id: consultee.id,
            name: consultee.name,
            email: consultee.email,
            avatar: consultee.image,
          }
        : null,
      scheduledAt: scheduledAtDate.toISOString(),
      endsAt: slot?.endsAt ? slot.endsAt.toISOString() : undefined,
      duration: headline.durationMinutes,
      status: displayStatus,
      bookingSource: headline.bookingSource,
      free,
      removed,
      hasIssue,
      issueType,
      payment: payment
        ? {
            id: payment.id,
            amount: payment.amount,
            currency: payment.currency,
            status: payment.paymentStatus,
            gateway: payment.paymentGateway,
            expiresAt: payment.expiresAt?.toISOString() ?? null,
          }
        : null,
      reschedule: apt.rescheduleRequests[0]
        ? {
            status: apt.rescheduleRequests[0].status,
            initiatorRole: apt.rescheduleRequests[0].initiatorRole,
            expiresAt: apt.rescheduleRequests[0].expiresAt.toISOString(),
          }
        : null,
      createdAt: apt.createdAt.toISOString(),
    };
  });

  // #897 — status filtering and counts now run in the DB above, so the page is
  // already the correct slice and the tab badges are global, not page-scoped.
  const counts = {
    all: allCount,
    issues: issuesCount,
    scheduled: scheduledCount,
    completed: completedCount,
  };

  // toPlain — payment rows carry the #780/#781 money result extension's inspect
  // symbol, so the payload must be plainified before crossing the RSC→Client
  // HydrationBoundary.
  return toPlain({
    appointments: formattedAppointments,
    counts,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasMore: offset + limit < total,
    },
  });
}
