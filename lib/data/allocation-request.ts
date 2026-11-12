import prisma from "@/lib/prisma";
import { SETTLED_CONSULTATION } from "@/lib/booking/approve-request";
import { toPlain } from "@/lib/data/serialize";
import { reportSentryError } from "@/lib/observability/report";
import type { OccurrenceLike } from "@/lib/appointments/view-model";
import type { AppointmentStatus } from "@prisma/client";
import { isReleasedForReschedule } from "@/utils/scheduling-engine/types";
import {
  planWeekStartsAt,
  soldSessionMinutes,
  soldSessionsPerWeek,
  soldTermsOf,
  subscriptionEntitlement,
  type SubscriptionEntitlement,
} from "@/lib/booking/entitlement";
import { bookedSessionMinutes } from "@/lib/appointments/occurrences";

/**
 * The one pending request the allocate page is placing.
 *
 * Keyed by the CONSULTATION/SUBSCRIPTION id, not an appointment id: the
 * `Appointment` row is downstream of the request and does not exist at all for
 * one that has never been scheduled, which is the ordinary case here.
 */

export type AllocationEventType = "consultation" | "subscription";

export interface AllocationRequest {
  id: string;
  eventType: AllocationEventType;
  title: string;
  status: AppointmentStatus;
  /** Owner of the plan — the page's ownership check. */
  consultantProfileId: string;
  /** The buyer, so the grid greys out times they are already booked at. */
  consulteeUserId?: string;
  consulteeName?: string;
  durationInHours?: number;
  sessionDurationInHours?: number;
  sessionsPerWeek?: number;
  durationInMonths?: number;
  totalSessions?: number;
  schedulingTimezone?: string;
  /** #1766 — the current cycle's window, not the stored (first-cycle) period. */
  allowedStart?: Date;
  allowedEnd?: Date;
  /** #1766 — the one counter the page's heading and batch size read. */
  entitlement?: SubscriptionEntitlement;
  /** Zone-midnight start of the plan week being filled. */
  cycleStartsAt?: Date;
  /**
   * Some slot is released and awaiting a new time, i.e. this is a partial
   * reschedule rather than a fresh allocation — which is exactly when the
   * `initialAllocation` guard must NOT fire (#837).
   */
  hasReleasedSlots: boolean;
  /** Paid (or free): a placed session needs 15 min notice, else 2 h to pay first. */
  settled: boolean;
  /**
   * The times already asked for on the placeholder appointment — the buyer's
   * requested times, or the ones left behind by a partial reschedule. Same
   * rows `hasReleasedSlots` is derived from; the picker opens on the earliest
   * of them (#1073).
   */
  slots: OccurrenceLike[];
}

const requestedBySelect = {
  select: { userId: true, user: { select: { name: true } } },
} as const;

/** Enough of a slot to place it on the grid, and to say whether it is live. */
const slotSelect = {
  select: {
    id: true,
    appointmentId: true,
    startsAt: true,
    endsAt: true,
    isTentative: true,
    completionStatus: true,
    // A10 tombstone (#676): a deleted slot is not a time anyone requested.
    deletedAt: true,
  },
} as const;

/**
 * #1780 R-2 (FAMILIARISE_WEB-4X) — the allocate page's read answers null for
 * a missing or foreign id instead of throwing, so the page reaches its own
 * notFound(). A request owned by another consultant reads as missing.
 */
export async function readAllocationRequest(
  requestId: string,
  eventType: AllocationEventType,
  consultantProfileId?: string,
): Promise<AllocationRequest | null> {
  try {
    const request = await readAllocationRequestOrThrow(requestId, eventType);
    if (
      request &&
      consultantProfileId &&
      request.consultantProfileId !== consultantProfileId
    ) {
      return null;
    }
    return request;
  } catch (error) {
    reportSentryError(error, {
      subsystem: "bookings",
      op: "read-allocation-request",
      expected: true,
      extra: { requestId, eventType },
    });
    return null;
  }
}

async function readAllocationRequestOrThrow(
  requestId: string,
  eventType: AllocationEventType,
): Promise<AllocationRequest | null> {
  if (eventType === "subscription") {
    const subscription = await prisma.subscription.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        status: true,
        schedulingPeriodStartsAt: true,
        schedulingPeriodEndsAt: true,
        schedulingTimezone: true,
        planEndsAt: true,
        sessionsTotal: true,
        sessionsPerWeek: true,
        sessionMinutes: true,
        sessionsRefunded: true,
        requestedBy: requestedBySelect,
        subscriptionPlan: {
          select: {
            title: true,
            consultantProfileId: true,
            sessionsPerWeek: true,
            sessionDurationInHours: true,
            durationInMonths: true,
            totalSessions: true,
          },
        },
        appointment: {
          select: { occurrences: slotSelect },
        },
      },
    });
    if (!subscription?.subscriptionPlan) return null;

    const plan = subscription.subscriptionPlan;
    const occurrences = subscription.appointment?.occurrences ?? [];
    const entitlement = subscriptionEntitlement({
      ...soldTermsOf(subscription),
      occurrences,
      schedulingPeriodStartsAt: subscription.schedulingPeriodStartsAt,
      schedulingTimezone: subscription.schedulingTimezone,
      planEndsAt: subscription.planEndsAt,
    });
    return toPlain<AllocationRequest>({
      id: subscription.id,
      eventType: "subscription",
      // A plan is allocated only once paid (an unpaid one is refused).
      settled: true,
      title: plan.title,
      status: subscription.status,
      consultantProfileId: plan.consultantProfileId,
      consulteeUserId: subscription.requestedBy?.userId,
      consulteeName: subscription.requestedBy?.user?.name,
      sessionDurationInHours: soldSessionMinutes(subscription) / 60,
      sessionsPerWeek: soldSessionsPerWeek(subscription),
      durationInMonths: plan.durationInMonths,
      totalSessions: entitlement.total,
      schedulingTimezone: subscription.schedulingTimezone,
      allowedStart: entitlement.cycle.windowStart,
      allowedEnd: entitlement.cycle.windowEnd,
      entitlement,
      cycleStartsAt: planWeekStartsAt(
        {
          ...soldTermsOf(subscription),
          schedulingPeriodStartsAt: subscription.schedulingPeriodStartsAt,
          schedulingTimezone: subscription.schedulingTimezone,
        },
        entitlement.cycle.ordinal,
      ),
      hasReleasedSlots:
        subscription.appointment?.occurrences.some(isReleasedForReschedule) ??
        false,
      slots: subscription.appointment?.occurrences ?? [],
    });
  }

  const consultation = await prisma.consultation.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      status: true,
      requestedBy: requestedBySelect,
      consultationPlan: {
        select: {
          title: true,
          consultantProfileId: true,
          durationInHours: true,
        },
      },
      appointment: { select: { occurrences: slotSelect } },
    },
  });
  if (!consultation?.consultationPlan) return null;

  const plan = consultation.consultationPlan;
  // The same money predicate the allocator and the approval CAS ride.
  const settled =
    (await prisma.consultation.count({
      where: { id: consultation.id, ...SETTLED_CONSULTATION },
    })) > 0;
  return toPlain<AllocationRequest>({
    id: consultation.id,
    eventType: "consultation",
    settled,
    title: plan.title,
    status: consultation.status,
    consultantProfileId: plan.consultantProfileId,
    consulteeUserId: consultation.requestedBy?.userId,
    consulteeName: consultation.requestedBy?.user?.name,
    durationInHours:
      (bookedSessionMinutes(consultation.appointment?.occurrences ?? []) ??
        plan.durationInHours * 60) / 60,
    hasReleasedSlots: (consultation.appointment?.occurrences ?? []).some(
      isReleasedForReschedule,
    ),
    slots: consultation.appointment?.occurrences ?? [],
  });
}
