// The buyer's own live, resumable hold on exactly this booking, which
// occupancy checks exclude so the open-order resume can reach it.

import type { Tx } from "@/lib/prisma";
import type { CheckoutInput } from "@/schemas/checkout";
import { PaymentGateway, PaymentStatus, Prisma } from "@prisma/client";

/**
 * The one definition of "this buyer's hold is still live".
 *
 * #1463 — step 2 below and the self-hold exclusion must agree exactly on what
 * a live hold is, or a hold could be excluded from one and not the other. The
 * shape is the one step 2 has always used: still PENDING, and either inside its
 * minted expiry window or young enough that the window has not been stamped yet.
 * `deletedAt: null` is the single addition, matching what
 * `findReusablePendingOrderPayment` will adopt — a soft-deleted payment is not
 * a hold anybody can resume.
 *
 * Liveness only. The self-hold exclusion narrows this further with the resume
 * gate's own scope (gateway + org) — see `findSelfHoldAppointmentIds`. Step 2's
 * duplicate-attempt guard must NOT carry that scope: it asks "does this buyer
 * already hold this window at all", and scoping it would let a second attempt
 * on another gateway slip past the guard entirely.
 */
export function buildLiveHoldPaymentFilter(
  buyerUserId: string,
  now: Date,
): Prisma.PaymentWhereInput {
  return {
    userId: buyerUserId,
    paymentStatus: PaymentStatus.PENDING,
    deletedAt: null,
    OR: [
      { expiresAt: { gt: now } },
      {
        AND: [
          { expiresAt: null },
          { createdAt: { gte: new Date(now.getTime() - 5 * 60 * 1000) } },
        ],
      },
    ],
  };
}

/**
 * #1463 — the appointments that are this buyer's OWN open order for exactly
 * this booking, and therefore are not occupants of the slot they hold.
 *
 * A buyer who closes the gateway modal and clicks Pay again used to be told
 * "Time slot is already booked" by their own hold, which made the documented
 * open-order resume (`findReusablePendingOrderPayment`, "Rec C") unreachable:
 * the availability gate ran first and threw. Excluding these appointments lets
 * the request reach that gate, which then either resumes the same gateway order
 * or supersedes it and releases the hold.
 *
 * The exclusion is deliberately as narrow as the resume gate itself. It takes
 * the same buyer, the same plan, the same gateway and the same org scope, a
 * payment that is still PENDING and still live, and a window that matches
 * EXACTLY — a different buyer, a different plan, or any
 * overlapping-but-different window keeps blocking, and a shape whose plan
 * identity cannot be resolved (webinars and classes, whose slots are shared
 * between attendees) is never excluded at all.
 *
 * #1465-triage — gateway and org are part of that narrowness, not decoration.
 * `findReusablePendingOrderPayment` requires both to match before it will
 * resume or supersede a candidate, so a hold minted on a different gateway (or
 * under a different org scope) is one this request can neither adopt nor
 * expire. Excluding it from availability without those two terms let the same
 * buyer mint a SECOND tentative appointment and a second payable order over the
 * same window, and both orders could capture. A hold that cannot be resumed
 * must keep blocking; the buyer waits out its `expiresAt` instead of
 * double-paying.
 *
 * Exactness is decided in code rather than in the WHERE clause because a booked
 * window is stored as N contiguous 30-minute atoms (#1319), so no single row
 * carries both endpoints: the run's first start and last end are what must
 * equal the request.
 */
export async function findSelfHoldAppointmentIds(
  tx: Tx,
  params: {
    buyerUserId: string;
    appointmentType: CheckoutInput["appointmentType"];
    planId: string;
    /** The gateway this request will mint on — the resume gate's own scope. */
    paymentGateway: PaymentGateway;
    /** Server-resolved org scope; null for personal/marketplace checkouts. */
    organizationId: string | null;
    slotStart: Date;
    slotEnd: Date;
    now: Date;
  },
): Promise<string[]> {
  // A switch rather than a ternary chain: sonar S3358 flags the nested form,
  // and the exhaustive shape is what keeps a new appointment type from silently
  // inheriting an exclusion it was never reasoned about.
  let planScope: Prisma.AppointmentWhereInput | null;
  switch (params.appointmentType) {
    case "CONSULTATION":
      planScope = { consultation: { consultationPlanId: params.planId } };
      break;
    case "SUBSCRIPTION":
      planScope = { subscription: { subscriptionPlanId: params.planId } };
      break;
    default:
      planScope = null;
  }
  if (!planScope) return [];

  const candidates = await tx.appointment.findMany({
    where: {
      ...planScope,
      deletedAt: null,
      payment: {
        some: {
          // #1478 — match any PENDING hold for this buyer/gateway/org on the
          // exact window (even if expiresAt has just lapsed and the cron has
          // not swept it yet), because findReusablePendingOrderPayment +
          // releaseSupersededHolds will supersede and release it before Step 5.
          userId: params.buyerUserId,
          paymentStatus: PaymentStatus.PENDING,
          deletedAt: null,
          // The two terms `findReusablePendingOrderPayment` also requires.
          // Null-safe org equality: personal stays personal.
          paymentGateway: params.paymentGateway,
          organizationId: params.organizationId,
        },
      },
      // Cheap index-served pre-filter on the run's first atom; the run's full
      // extent is checked below.
      occurrences: {
        some: {
          startsAt: params.slotStart,
          isTentative: true,
          deletedAt: null,
        },
      },
    },
    select: {
      id: true,
      occurrences: {
        where: { deletedAt: null },
        select: { startsAt: true, endsAt: true },
      },
    },
    // Bounded: one buyer can hold one window on one plan; anything beyond a
    // handful is a state this exclusion should not be widening for anyway.
    take: 5,
  });

  return candidates
    .filter((appointment) => {
      const slots = appointment.occurrences;
      if (slots.length === 0) return false;
      const runStart = Math.min(...slots.map((s) => s.startsAt.getTime()));
      const runEnd = Math.max(...slots.map((s) => s.endsAt.getTime()));
      return (
        runStart === params.slotStart.getTime() &&
        runEnd === params.slotEnd.getTime()
      );
    })
    .map((appointment) => appointment.id);
}
