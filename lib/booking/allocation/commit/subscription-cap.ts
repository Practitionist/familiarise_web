// Debits an org-sponsored subscription's programme cap per new occurrence,
// and settles any overage, inside the allocation transaction.

import { recordSystemErrorSafe } from "@/lib/enterprise/system-events";
import type { Tx } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import {
  recordBookingUtilization,
  reverseBookingUtilization,
} from "@/lib/api/organizations/program-helpers";

/**
 * For SUBSCRIPTION: debit `engagementsConsumed` per occurrence created in
 * this allocation batch against the consultee's active org program
 * assignment. No-op when the booking isn't org-sponsored. #1554 —
 * `BookingUtilization.appointmentIds` holds the OCCURRENCE ids here: the
 * engagement is the call, and the wrapper is one row for the whole plan.
 *
 * Throws `ProgramAssignmentLimitError` if the cap is BLOCK and would
 * be exceeded — the surrounding transaction rolls back the new slots.
 */
export async function recordSubscriptionAllocationCap(
  tx: Tx,
  subscriptionId: string,
  consulteeUserId: string,
  newOccurrenceIds: string[],
): Promise<void> {
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

  // Schema declares Appointment.payment as Payment[] (one Appointment
  // can carry multiple Payments historically — refunds/retries chain
  // off the original). Pick the EARLIEST org-tagged one: an unordered
  // .find() over a retry chain debits whichever row the DB happened to
  // return first, landing utilization on the wrong ProgramAssignment cycle
  // (#1169 PR 1).
  const orgPayment = (subscription?.appointment?.payment ?? [])
    .filter((p) => !!p.organizationId)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];

  if (!orgPayment || !orgPayment.organizationId) {
    // PERSONAL-funded subscription — no org cap to debit.
    return;
  }

  const membership = await tx.membership.findUnique({
    where: {
      userId_organizationId: {
        userId: consulteeUserId,
        organizationId: orgPayment.organizationId,
      },
    },
  });
  if (!membership || membership.status !== "ACTIVE") return;

  // Re-resolve the active ProgramAssignment at allocation time.
  // Mirrors the resolver in lib/payments/operations/checkout.ts so the
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
  if (!assignment) return;

  // priceAtBookingPaise: full upfront sub price on the very first
  // allocation (so the BookingUtilization row carries it for
  // analytics); 0 on subsequent allocations (no new money). The
  // helper's upsert preserves the first-create priceAtBookingPaise.
  const existingUtil = await tx.bookingUtilization.findUnique({
    where: { paymentId: orgPayment.id },
    select: { id: true, appointmentIds: true },
  });
  const priceAtBookingPaise = existingUtil ? 0 : orgPayment.amount;

  // Re-allocation deletes counted occurrences and recreates them with
  // fresh ids, so an id-set diff alone re-debits every replaced session.
  // Substitute stale tracked ids (no longer live on this subscription)
  // with incoming ids 1:1 WITHOUT debiting; only ids beyond the
  // substitution budget are genuinely additional sessions.
  let idsToDebit = newOccurrenceIds;
  if (existingUtil) {
    const liveIds = new Set(
      (subscription!.appointment?.occurrences ?? []).map((o) => o.id),
    );
    const trackedLive = existingUtil.appointmentIds.filter((id) =>
      liveIds.has(id),
    );
    const staleCount = existingUtil.appointmentIds.length - trackedLive.length;
    if (staleCount > 0) {
      const alreadyTracked = new Set(trackedLive);
      const incomingNew = newOccurrenceIds.filter(
        (id) => !alreadyTracked.has(id),
      );
      const substituted = incomingNew.slice(0, staleCount);
      idsToDebit = incomingNew.slice(staleCount);
      await tx.bookingUtilization.update({
        where: { id: existingUtil.id },
        data: { appointmentIds: [...trackedLive, ...substituted] },
      });

      // The substitution above only cancels out the sessions that were
      // REPLACED. Sessions removed and not re-created in this allocation
      // (a partial reschedule that drops 3 and re-places 1, an in-progress
      // reallocation that shrinks the remaining plan) were left debited
      // forever: the org kept paying for engagements the consultee will
      // never take, and the seat never came back. Give the difference back
      // through the ledger-derived reversal, which is idempotent and clamps
      // itself to what is still reversible.
      const netRemoved = staleCount - substituted.length;
      if (netRemoved > 0) {
        await reverseBookingUtilization(tx, {
          paymentId: orgPayment.id,
          engagementsToReverse: netRemoved,
          reason: "Subscription sessions removed during re-allocation",
        });
      }

      if (idsToDebit.length === 0) return;
    }
  }

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

  // #1895 — Trigger overage billing when a lazily allocated subscription
  // session exceeds the program cap.
  if (utilResult?.wasOverage) {
    await settleSubscriptionAllocationOverage({
      tx,
      subscriptionId,
      subscription,
      orgPayment,
      assignment,
      existingUtil,
      idsToDebit,
      utilResult,
      consulteeUserId,
    });
  }
}

export async function settleSubscriptionAllocationOverage(params: {
  tx: Tx;
  subscriptionId: string;
  subscription: {
    subscriptionPlanId?: string;
    sessionsTotal?: number | null;
    subscriptionPlan?: {
      totalSessions?: number | null;
      price?: number | null;
    } | null;
  } | null;
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
}): Promise<void> {
  const {
    tx,
    subscriptionId,
    subscription,
    orgPayment,
    assignment,
    existingUtil,
    idsToDebit,
    utilResult,
    consulteeUserId,
  } = params;
  if (!orgPayment.organizationId) return;

  const totalPlanSessions = Math.max(
    1,
    subscription?.sessionsTotal ??
      subscription?.subscriptionPlan?.totalSessions ??
      1,
  );
  const basePaymentAmount = orgPayment.originalAmount ?? orgPayment.amount;
  let unitSessionPricePaise = Math.round(basePaymentAmount / totalPlanSessions);
  if (unitSessionPricePaise <= 0) {
    const planPricePaise =
      subscription?.subscriptionPlan?.price ??
      (subscription?.subscriptionPlanId
        ? (
            await tx.subscriptionPlan?.findUnique?.({
              where: { id: subscription.subscriptionPlanId },
              select: { price: true },
            })
          )?.price
        : undefined);
    if (typeof planPricePaise === "number" && planPricePaise > 0) {
      unitSessionPricePaise = Math.round(planPricePaise / totalPlanSessions);
    }
  }

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
    return;
  }

  const overageBookingPricePaise = idsToDebit.length * unitSessionPricePaise;
  const { recordOverageAtCheckout, notifyOverageDueAfterCommit } =
    await import("@/lib/payments/billing/overage-settlement");
  const resolvedProgramType =
    assignment.program?.type ?? utilResult.programType ?? "LICENSED_SEAT";
  const lazyCreditDelta = existingUtil ? overageBookingPricePaise : 0;
  const effectiveConsumedPaiseAfter =
    resolvedProgramType === "CREDIT_POOL"
      ? utilResult.consumedPaiseAfter + lazyCreditDelta
      : utilResult.consumedPaiseAfter;
  const pendingNotify = await recordOverageAtCheckout({
    tx,
    programAssignmentId: assignment.id,
    utilization: {
      programType: resolvedProgramType,
      engagementsConsumedDelta: utilResult.engagementsConsumedDelta,
      engagementsUsedAfter: utilResult.engagementsUsedAfter,
      consumedPaiseAfter: effectiveConsumedPaiseAfter,
      creditBudgetPaise: utilResult.creditBudgetPaise,
    },
    bookingPricePaise: overageBookingPricePaise,
    currency: orgPayment.currency ?? "INR",
    paymentId: orgPayment.id,
    userId: consulteeUserId,
    organizationId: orgPayment.organizationId,
    paymentGateway: orgPayment.paymentGateway ?? "RAZORPAY",
    isLazyAllocation: existingUtil !== null,
  });
  if (pendingNotify) {
    notifyOverageDueAfterCommit(pendingNotify);
  }
}
