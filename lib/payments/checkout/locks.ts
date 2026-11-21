// Checkout's lock envelope: the event or slot lock, acquired and released as
// one unit through utils/appointmentlock, and the in-lock plan re-read.

import { Refusal } from "@/lib/errors/refusal";
import { EVENT_SEAT_TIMES_SENT_MESSAGE } from "@/lib/errors/classification/payment-error-classification";
import {
  assertExpertTakesDirectCheckout,
  assertExpertVerified,
} from "@/lib/booking/booking-rule-error";
import { CHECKOUT_LABEL } from "@/lib/booking/expert-standing";
import type { BookingMode, ConsultantVerificationStatus } from "@prisma/client";
import {
  OCCUPYING_OCCURRENCE_WHERE,
  seatHoldingParticipant,
} from "@/utils/scheduling-engine/occupancyPolicy";
import prisma, { type Tx } from "@/lib/prisma";
import type { CheckoutInput } from "@/schemas/checkout";
import {
  CHECKOUT_WAIT_RETRY_CONFIG,
  EventFullError,
  lockSlotBatch,
  unlockSlotBooking,
  lockEventCheckout,
  unlockEventCheckout,
  lockRequestCap,
  RequestCapBusyError,
  EventCheckoutBusyError,
  CHECKOUT_LOCK_TTL_MS,
  ApprovalLock,
  type SlotBatchGrant,
} from "@/utils/appointmentlock";
import { getClassCapacity, getWebinarCapacity } from "@/lib/events/capacity";

/**
 * A seat buyer who is an expert too is busy on their own calendar for every
 * session still ahead on the event: their own slot atoms, taken after the
 * event and consultee keys. Null when the buyer hosts nothing.
 */
export async function lockBuyerSeatAtoms(
  userId: string,
  appointmentType: "WEBINAR" | "CLASS",
  eventId: string,
): Promise<SlotBatchGrant | null> {
  const buyer = await prisma.consultantProfile.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!buyer) return null;
  const sessions = await prisma.appointmentOccurrence.findMany({
    where: {
      appointment:
        appointmentType === "WEBINAR"
          ? { webinarId: eventId }
          : { classId: eventId },
      ...OCCUPYING_OCCURRENCE_WHERE,
      endsAt: { gt: new Date() },
    },
    select: { startsAt: true, endsAt: true },
  });
  if (sessions.length === 0) return null;
  return lockSlotBatch(
    sessions.map((s) => ({ consultantProfileId: buyer.id, ...s })),
    CHECKOUT_LOCK_TTL_MS[appointmentType],
    CHECKOUT_WAIT_RETRY_CONFIG,
  );
}

/**
 * One expert's plan sales, on the consultant-tier `request-cap:` key: held from
 * the sold-plan counts through the new hold's commit. Contention reads as a
 * busy plan checkout, which the client retries once.
 */
export async function lockExpertPlanSales(
  consultantProfileId: string,
): Promise<ApprovalLock> {
  try {
    return await lockRequestCap(
      consultantProfileId,
      CHECKOUT_LOCK_TTL_MS.SUBSCRIPTION,
    );
  } catch (error) {
    if (error instanceof RequestCapBusyError) {
      throw new EventCheckoutBusyError("SUBSCRIPTION");
    }
    throw error;
  }
}

/**
 * Get plan data needed for lock acquisition
 * Returns consultant profile info for slot-based locking
 *
 * FIX Bug #04: Changed from userId to id (consultantProfileId) to match
 * the lock key used in request-for-approval flow. All slot locks must use
 * the same identity (consultantProfileId) to prevent parallel bypass.
 */
export async function getPlanDataForLock(
  data: CheckoutInput,
): Promise<{ consultantProfile?: { id: string } }> {
  // For CONSULTATION and SUBSCRIPTION, we need consultant profile ID for slot locking
  if (data.appointmentType === "CONSULTATION") {
    const plan = await prisma.consultationPlan.findUnique({
      where: { id: data.planId },
      select: {
        consultantProfile: {
          select: { id: true },
        },
      },
    });
    if (!plan) throw new Error("Consultation plan not found");
    return plan;
  }

  if (data.appointmentType === "SUBSCRIPTION") {
    const plan = await prisma.subscriptionPlan.findUnique({
      where: { id: data.planId },
      select: {
        consultantProfile: {
          select: { id: true },
        },
      },
    });
    if (!plan) throw new Error("Subscription plan not found");
    return plan;
  }

  // For WEBINAR/CLASS, we don't need consultant ID (event-based locking)
  return {};
}

/**
 * B4 — OPTIMISTIC capacity read for WEBINAR/CLASS, run BEFORE the event
 * checkout mutex. Mirrors the in-lock recount's query shape exactly (same
 * includes, same capacity helpers, same host-exclusion rule) so the two can
 * only disagree inside the near-capacity race window that Serializable
 * isolation arbitrates. Advisory-only: a full answer here is terminal for
 * this request (sold out); a not-full answer proves nothing and the mutex +
 * recount still decide.
 */
export async function readEventCapacity(
  appointmentType: "WEBINAR" | "CLASS",
  eventId: string,
): Promise<{ isFull: boolean }> {
  if (appointmentType === "WEBINAR") {
    const webinar = await prisma.webinar.findUnique({
      where: { id: eventId },
      relationLoadStrategy: "join",
      include: {
        webinarPlan: { include: { consultantProfile: true } },
        appointment: {
          include: {
            participants: {
              where: seatHoldingParticipant(new Date()),
              select: { userId: true },
            },
          },
        },
      },
    });
    if (!webinar) return { isFull: false }; // not-found → let the lock path report it
    const consultantUserId = webinar.webinarPlan.consultantProfile?.userId;
    return getWebinarCapacity({
      webinar,
      plan: webinar.webinarPlan,
      excludeUserIds: consultantUserId ? [consultantUserId] : [],
    });
  }

  const classInstance = await prisma.class.findUnique({
    where: { id: eventId },
    include: {
      classPlan: { include: { consultantProfile: true } },
      appointment: {
        include: {
          participants: {
            where: seatHoldingParticipant(new Date()),
            select: { userId: true },
          },
        },
      },
    },
  });
  if (!classInstance) return { isFull: false };
  const ownerUserId = classInstance.classPlan.consultantProfile?.userId;
  return getClassCapacity({
    classInstance,
    plan: classInstance.classPlan,
    excludeUserIds: ownerUserId ? [ownerUserId] : [],
  });
}

/**
 * Acquire appropriate lock based on checkout type
 * Returns lock or null if no locking needed
 */
export async function acquireCheckoutLock(
  data: CheckoutInput,
  planData: { consultantProfile?: { id: string } },
  /** The buyer's own expert profile: an expert booking another expert is busy on both calendars. */
  buyerConsultantProfileId: string | null = null,
): Promise<ApprovalLock | ApprovalLock[] | null> {
  const appointmentType = data.appointmentType;

  // Strategy A: Slot-based locking (CONSULTATION + direct SUBSCRIPTION)
  // FIX Bug #04: Use consultantProfileId (not userId) to match request-for-approval lock key
  if (data.startsAt && data.endsAt) {
    let consultantProfileId: string;

    if (
      appointmentType === "CONSULTATION" ||
      appointmentType === "SUBSCRIPTION"
    ) {
      consultantProfileId = planData.consultantProfile!.id;
    } else {
      // The schema refuses this first; a direct caller gets the same 400.
      throw new Refusal({
        code: "EVENT_SEAT_TIMES_SENT",
        httpStatus: 400,
        userMessage: EVENT_SEAT_TIMES_SENT_MESSAGE,
        devMessage: `${appointmentType} checkout carried startsAt/endsAt`,
      });
    }

    console.log(
      JSON.stringify({
        event: "checkout_lock_acquiring",
        type: "slot-based",
        appointmentType,
        consultantProfileId,
        slot: data.startsAt,
        timestamp: new Date().toISOString(),
      }),
    );

    // #1169 PR 1 — interval-granular: every 30-min atom of [startsAt, endsAt)
    // is locked, so an overlapping booking with a DIFFERENT start collides
    // instead of sailing past on a different instant key.
    const window = { startsAt: data.startsAt, endsAt: data.endsAt };
    return await lockSlotBatch(
      [
        { consultantProfileId, ...window },
        ...(buyerConsultantProfileId &&
        buyerConsultantProfileId !== consultantProfileId
          ? [{ consultantProfileId: buyerConsultantProfileId, ...window }]
          : []),
      ],
      CHECKOUT_LOCK_TTL_MS[appointmentType], // #832 — per-type budget
    );
  }

  // Strategy B: Event-based locking (WEBINAR, CLASS, scheduling-period SUBSCRIPTION)
  if (appointmentType === "WEBINAR" || appointmentType === "CLASS") {
    if (!data.eventId) {
      throw new Error(`${appointmentType} checkout requires event ID`);
    }

    console.log(
      JSON.stringify({
        event: "checkout_lock_acquiring",
        type: "event-based",
        appointmentType,
        eventId: data.eventId,
        timestamp: new Date().toISOString(),
      }),
    );

    // B4 (booking-journey audit) — OPTIMISTIC CAPACITY PRE-CHECK before the
    // mutex. During a drop, hundreds of buyers serialize behind one
    // event-checkout key only to discover inside the lock that the event is
    // full; with a 26s function ceiling most of them died as raw 504s. One
    // bounded read here answers "already sold out" for the overwhelming
    // majority WITHOUT touching the mutex — the Serializable recount inside
    // remains the authoritative gate for the near-capacity race.
    const preCheck = await readEventCapacity(appointmentType, data.eventId);
    if (preCheck.isFull) {
      throw new EventFullError(appointmentType);
    }

    return await lockEventCheckout(
      appointmentType,
      data.eventId,
      CHECKOUT_LOCK_TTL_MS[appointmentType], // #832 — per-type budget
      CHECKOUT_WAIT_RETRY_CONFIG, // B4 — fail fast, never queue past the ceiling
    );
  }

  // Scheduling period SUBSCRIPTION (no slots during checkout)
  if (appointmentType === "SUBSCRIPTION" && data.schedulingPeriodStartsAt) {
    console.log(
      JSON.stringify({
        event: "checkout_lock_acquiring",
        type: "event-based",
        appointmentType: "SUBSCRIPTION",
        planId: data.planId,
        timestamp: new Date().toISOString(),
      }),
    );

    return await lockEventCheckout(
      appointmentType,
      data.planId,
      CHECKOUT_LOCK_TTL_MS[appointmentType], // #832 — per-type budget
      CHECKOUT_WAIT_RETRY_CONFIG,
    );
  }

  // Should not reach here if validation is correct
  console.warn(
    JSON.stringify({
      event: "checkout_no_lock_needed",
      appointmentType,
      planId: data.planId,
      eventId: data.eventId ?? null,
      timestamp: new Date().toISOString(),
    }),
  );

  return null;
}

/**
 * Release checkout lock safely (for finally blocks)
 */
export async function releaseCheckoutLock(
  lock: ApprovalLock | ApprovalLock[] | null,
  lockType: string,
): Promise<void> {
  if (!lock) return;

  if (Array.isArray(lock)) {
    await unlockSlotBooking(lock);
  } else {
    await unlockEventCheckout(lock);
  }

  console.log(
    JSON.stringify({
      event: "checkout_lock_released",
      lockType,
      timestamp: new Date().toISOString(),
    }),
  );
}

/**
 * BUG-E: Verify plan still exists inside lock
 * Prevents race condition where plan is deleted between initial validation and checkout
 */

export async function verifyPlanExistsInsideLock(
  tx: Tx,
  appointmentType: string,
  planId: string,
  eventId?: string | null,
): Promise<{
  consultantProfileId: string | null;
  organizationId: string | null;
  /** ACCEPTED collaborators' profile ids; only webinar and class plans have any. */
  collaboratorProfileIds: string[];
}> {
  // The expert's verification and a 1:1's switches are re-read under the lock, before any gateway order exists.
  const select = {
    consultantProfileId: true,
    organizationId: true,
    consultantProfile: {
      select: {
        verificationStatus: true,
        acceptingRequests: true,
        bookingMode: true,
      },
    },
  } as const;
  const collaborators = {
    where: { status: { in: ["PENDING" as const, "ACCEPTED" as const] } },
    select: { consultantProfileId: true },
  };
  let plan: {
    consultantProfileId: string | null;
    organizationId: string | null;
    collaborators?: { consultantProfileId: string }[];
    consultantProfile: {
      verificationStatus: ConsultantVerificationStatus;
      acceptingRequests: boolean;
      bookingMode: BookingMode;
    } | null;
  } | null = null;

  switch (appointmentType) {
    case "CONSULTATION":
      plan = await tx.consultationPlan.findUnique({
        where: { id: planId },
        select,
      });
      break;
    case "SUBSCRIPTION":
      plan = await tx.subscriptionPlan.findUnique({
        where: { id: planId },
        select,
      });
      break;
    case "WEBINAR":
      plan = await tx.webinarPlan.findUnique({
        where: { id: planId },
        select: { ...select, collaborators },
      });
      break;
    case "CLASS":
      plan = await tx.classPlan.findUnique({
        where: { id: planId },
        select: { ...select, collaborators },
      });
      break;
  }

  if (!plan) {
    throw new Error(
      "This plan is no longer available. Please refresh and try again.",
    );
  }
  assertExpertTakesDirectCheckout(appointmentType, plan.consultantProfile);
  assertExpertVerified(
    plan.consultantProfile,
    CHECKOUT_LABEL[appointmentType] ?? "This booking",
  );
  // A seat is sold from the event; the plan the self-booking and related-party
  // rules read must be that event's plan, never a client-chosen one.
  if (appointmentType === "WEBINAR" || appointmentType === "CLASS") {
    const matches =
      !!eventId &&
      (appointmentType === "WEBINAR"
        ? await tx.webinar.count({
            where: { id: eventId, webinarPlanId: planId },
          })
        : await tx.class.count({
            where: { id: eventId, classPlanId: planId },
          })) > 0;
    if (!matches) {
      throw new Refusal({
        code: "PLAN_EVENT_MISMATCH",
        httpStatus: 409,
        userMessage:
          "This session no longer matches its plan. Refresh and try again.",
        devMessage: `event ${eventId ?? "(none)"} is not on plan ${planId}`,
      });
    }
  }
  return {
    consultantProfileId: plan.consultantProfileId,
    organizationId: plan.organizationId,
    collaboratorProfileIds: (plan.collaborators ?? []).map(
      (c) => c.consultantProfileId,
    ),
  };
}
