// Debits an org-sponsored subscription's programme cap per new occurrence,
// and settles any overage, inside the allocation transaction.

import { recordSystemErrorSafe } from "@/lib/enterprise/system-events";
import type { Tx } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import {
  recordBookingUtilization,
  reverseBookingUtilization,
} from "@/lib/api/organizations/program-helpers";
import type { PendingOverageNotification } from "@/lib/payments/billing/overage-settlement";

/**
 * For SUBSCRIPTION: debit `engagementsConsumed` per occurrence created in
 * this allocation batch against the consultee's active org program
 * assignment. No-op when the booking isn't org-sponsored. #1554 —
 * `BookingUtilization.appointmentIds` holds the OCCURRENCE ids here: the
 * engagement is the call, and the wrapper is one row for the whole plan.
 *
 * Throws `ProgramAssignmentLimitError` if the cap is BLOCK and would
 * be exceeded — the surrounding transaction rolls back the new slots.
 * Returns the member-due overage notice for the caller to send after commit.
 */
export async function recordSubscriptionAllocationCap(
  tx: Tx,
  subscriptionId: string,
  consulteeUserId: string,
  newOccurrenceIds: string[],
): Promise<PendingOverageNotification | null> {
  // Find the original signup Payment via the purchase wrapper (#1554).
  const subscription = await tx.subscription.findUnique({
    where: { id: subscriptionId },
    include: {
      subscriptionPlan: { select: { totalSessions: true, price: true } },
      appointment: {
        include: {
          payment: true,
          occurrences: { where: { deletedAt: null }, select: { id: true } },
        },
      },
    },
  });
  if (!subscription) return null;

  // Schema declares Appointment.payment as Payment[] (one Appointment
  // can carry multiple Payments historically — refunds/retries chain
  // off the original). Pick the EARLIEST org-tagged one: an unordered
  // .find() over a retry chain debits whichever row the DB happened to
  // return first, landing utilization on the wrong ProgramAssignment cycle
  // (#1169 PR 1).
  const orgPayment = (subscription.appointment?.payment ?? [])
    .filter((p) => !!p.organizationId)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];

  if (!orgPayment || !orgPayment.organizationId) {
    // PERSONAL-funded subscription — no org cap to debit.
    return null;
  }

  const membership = await tx.membership.findUnique({
    where: {
      userId_organizationId: {
        userId: consulteeUserId,
        organizationId: orgPayment.organizationId,
      },
    },
  });
  if (membership?.status !== "ACTIVE") return null;

  // Re-resolve the active ProgramAssignment at allocation time.
  // Mirrors the resolver in lib/payments/checkout/org-funding.ts so the
  // same coverage filters apply (assignment ACTIVE, program ACTIVE,
  // contract ACTIVE, covers SUBSCRIPTION).
  const now = new Date();
  const assignment = await tx.programAssignment.findFirst({
    where: {
      membershipId: membership.id,
      // #1132 follow-up — checkout filters on status too; without it the
      // period window alone matched ROLLED / CLOSED / CANCELLED rows, so a
      // dead assignment inside its old window could still be debited by a
      // lazily-allocated subscription session.
      status: "ACTIVE",
      periodStart: { lte: now },
      periodEnd: { gte: now },
      program: {
        status: "ACTIVE",
        OR: [
          { coveredPlanTypes: { isEmpty: true } },
          { coveredPlanTypes: { has: "SUBSCRIPTION" } },
        ],
        contract: {
          organizationId: orgPayment.organizationId,
          status: "ACTIVE",
          effectiveFrom: { lte: now },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }],
        },
      },
    },
    orderBy: { periodEnd: "desc" },
    select: {
      id: true,
      program: {
        select: {
          type: true,
          licensedSeatConfig: {
            select: { priceCapPerEngagementPaise: true },
          },
        },
      },
    },
  });
  if (!assignment) return null;

  const existingUtil = await tx.bookingUtilization.findUnique({
    where: { paymentId: orgPayment.id },
    select: { id: true, appointmentIds: true },
  });

  // Re-allocation deletes counted occurrences and recreates them with
  // fresh ids, so an id-set diff alone re-debits every replaced session.
  // Substitute stale tracked ids (no longer live on this subscription)
  // with incoming ids 1:1 WITHOUT debiting; only ids beyond the
  // substitution budget are genuinely additional sessions.
  const tracked = existingUtil?.appointmentIds ?? [];
  const alreadyTracked = new Set(tracked);
  let idsToDebit = newOccurrenceIds.filter((id) => !alreadyTracked.has(id));
  if (existingUtil) {
    const liveIds = new Set(
      (subscription.appointment?.occurrences ?? []).map((o) => o.id),
    );
    const trackedLive = tracked.filter((id) => liveIds.has(id));
    const staleCount = tracked.length - trackedLive.length;
    if (staleCount > 0) {
      const substituted = idsToDebit.slice(0, staleCount);
      idsToDebit = idsToDebit.slice(staleCount);
      await tx.bookingUtilization.update({
        where: { id: existingUtil.id },
        data: { appointmentIds: [...trackedLive, ...substituted] },
      });

      // Sessions removed and not re-created give their engagement back
      // through the ledger-derived reversal, which clamps to what is left.
      const netRemoved = staleCount - substituted.length;
      if (netRemoved > 0) {
        await reverseBookingUtilization(tx, {
          paymentId: orgPayment.id,
          engagementsToReverse: netRemoved,
          reason: "Subscription sessions removed during re-allocation",
        });
      }

      if (idsToDebit.length === 0) return null;
    }
  }

  const sessionPrice = subscriptionSessionPrice(subscription, orgPayment);
  // A CREDIT_POOL draws its credit per session as sessions are booked; a
  // LICENSED_SEAT row carries the plan price once, on the first allocation.
  const priceAtBookingPaise =
    assignment.program?.type === "CREDIT_POOL"
      ? idsToDebit.length * sessionPrice.unitPaise
      : existingUtil
        ? 0
        : orgPayment.amount;

  // Not captured here — this only runs from createAppointments, itself only
  // reachable via allocate()'s try, whose catch reports every error
  // reaching it (a ProgramAssignmentLimitError cap-exceeded included,
  // correctly classified as one of its modelled outcomes). A capture here
  // too would be a dupe, so this no longer needs its own try/catch.
  const utilResult = await recordBookingUtilization(tx, {
    programAssignmentId: assignment.id,
    paymentId: orgPayment.id,
    engagementsConsumed: idsToDebit.length,
    priceAtBookingPaise,
    // PR-1e (G3): pass the occurrence ids so re-allocation
    // (delete+recreate of the same call) can't double-debit. The
    // helper computes the set diff against
    // BookingUtilization.appointmentIds and increments only by the
    // genuinely-new ids.
    appointmentIds: idsToDebit,
  });

  if (!utilResult?.wasOverage) return null;
  return settleSubscriptionAllocationOverage({
    tx,
    subscriptionId,
    sessionPrice,
    orgPayment,
    assignment,
    existingUtil,
    idsToDebit,
    utilResult,
    consulteeUserId,
  });
}

interface SubscriptionSessionPrice {
  unitPaise: number;
  totalPlanSessions: number;
  basePaymentAmount: number;
}

/** One session's share of the plan payment, falling back to the plan's list price. */
function subscriptionSessionPrice(
  subscription: {
    sessionsTotal: number | null;
    subscriptionPlan: { totalSessions: number; price: number } | null;
  },
  orgPayment: { amount: number; originalAmount: number | null },
): SubscriptionSessionPrice {
  const totalPlanSessions = Math.max(
    1,
    subscription.sessionsTotal ??
      subscription.subscriptionPlan?.totalSessions ??
      1,
  );
  const basePaymentAmount = orgPayment.originalAmount ?? orgPayment.amount;
  let unitPaise = Math.round(basePaymentAmount / totalPlanSessions);
  const planPricePaise = subscription.subscriptionPlan?.price ?? 0;
  if (unitPaise <= 0 && planPricePaise > 0) {
    unitPaise = Math.round(planPricePaise / totalPlanSessions);
  }
  return { unitPaise, totalPlanSessions, basePaymentAmount };
}

async function settleSubscriptionAllocationOverage(params: {
  tx: Tx;
  subscriptionId: string;
  sessionPrice: SubscriptionSessionPrice;
  orgPayment: {
    id: string;
    amount: number;
    originalAmount?: number | null;
    currency?: Prisma.PaymentCreateInput["currency"] | null;
    organizationId: string | null;
    paymentGateway?: Prisma.PaymentCreateInput["paymentGateway"] | null;
  };
  assignment: {
    id: string;
    program?: {
      type?: "LICENSED_SEAT" | "CREDIT_POOL" | null;
      licensedSeatConfig?: {
        priceCapPerEngagementPaise?: number | null;
      } | null;
    } | null;
  };
  existingUtil: { id: string } | null;
  idsToDebit: string[];
  utilResult: Awaited<ReturnType<typeof recordBookingUtilization>>;
  consulteeUserId: string;
}): Promise<PendingOverageNotification | null> {
  const {
    tx,
    subscriptionId,
    sessionPrice,
    orgPayment,
    assignment,
    existingUtil,
    idsToDebit,
    utilResult,
    consulteeUserId,
  } = params;
  if (!orgPayment.organizationId) return null;

  const {
    unitPaise: unitSessionPricePaise,
    totalPlanSessions,
    basePaymentAmount,
  } = sessionPrice;
  const programPriceCapPaise =
    assignment.program?.licensedSeatConfig?.priceCapPerEngagementPaise;
  if (unitSessionPricePaise <= 0 && (programPriceCapPaise ?? 0) <= 0) {
    await recordSystemErrorSafe({
      organizationId: orgPayment.organizationId,
      category: "OVERAGE_SUBSCRIPTION_NO_UNIT_PRICE",
      summary:
        "Subscription overage allocation resolved zero unit session price with no program price cap",
      err: new Error(
        `OVERAGE_SUBSCRIPTION_NO_UNIT_PRICE for subscription=${subscriptionId} payment=${orgPayment.id}`,
      ),
      db: tx,
      context: {
        subscriptionId,
        paymentId: orgPayment.id,
        programAssignmentId: assignment.id,
        basePaymentAmount,
        totalPlanSessions,
      },
    });
    return null;
  }

  const overageBookingPricePaise = idsToDebit.length * unitSessionPricePaise;
  const { recordOverageAtCheckout } =
    await import("@/lib/payments/billing/overage-settlement");
  const resolvedProgramType =
    assignment.program?.type ?? utilResult.programType ?? "LICENSED_SEAT";
  return recordOverageAtCheckout({
    tx,
    programAssignmentId: assignment.id,
    utilization: {
      programType: resolvedProgramType,
      engagementsConsumedDelta: utilResult.engagementsConsumedDelta,
      engagementsUsedAfter: utilResult.engagementsUsedAfter,
      consumedPaiseAfter: utilResult.consumedPaiseAfter,
      creditBudgetPaise: utilResult.creditBudgetPaise,
      usageLedgerEntryId: utilResult.usageLedgerEntryId,
    },
    bookingPricePaise: overageBookingPricePaise,
    currency: orgPayment.currency ?? "INR",
    paymentId: orgPayment.id,
    userId: consulteeUserId,
    organizationId: orgPayment.organizationId,
    paymentGateway: orgPayment.paymentGateway ?? "RAZORPAY",
    isLazyAllocation: existingUtil !== null,
  });
}
