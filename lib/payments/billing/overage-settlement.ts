/**
 * #778 elegance — checkout-time overage recording, extracted out of the (huge)
 * checkout function so the overage flow reads as one unit. The chargeStatus
 * state machine (`transitionOverage`) lives in `overage-transitions.ts` (kept
 * dependency-light); this module carries the heavier graph (computeOverage +
 * the Novu member-due notification).
 */
import prisma from "@/lib/prisma";
import {
  PaymentStatus,
  type Currency,
  type Prisma,
  type PaymentGateway,
  type ProgramType,
} from "@prisma/client";
import { computeOverageForBooking } from "@/lib/payments/billing/overage";
import { notifyOrgProgramOverageDue } from "@/lib/novu/org-workflows";
import type { Tx } from "@/lib/prisma";
import { sumPaise } from "@/lib/payments/utils/money";

export interface RecordOverageInput {
  tx: Tx;
  programAssignmentId: string;
  /** Output of recordBookingUtilization for this booking (already metered). */
  utilization: {
    programType: ProgramType;
    engagementsConsumedDelta: number;
    engagementsUsedAfter: number;
    consumedPaiseAfter: number;
    creditBudgetPaise: number | null;
  };
  bookingPricePaise: number;
  currency: Currency;
  paymentId: string;
  userId: string;
  organizationId: string | null;
  paymentGateway: PaymentGateway;
}

/**
 * Record one over-cap booking. Assumes the caller already metered the booking
 * and saw `wasOverage = true` (BLOCK behaviour throws inside the metering
 * helper, never here). Resolves the configured behaviour through the pure
 * `computeOverage`, enforces the per-cycle circuit breaker, and persists the
 * OverageEvent (+ the CHARGE_MEMBER side-Payment or the CHARGE_ORG accrual leg).
 *
 * Throws `PROGRAM_CAP_EXHAUSTED` (httpStatus 402) when the circuit breaker
 * vetoes — same shape as the BLOCK path so the dashboard can explain the
 * cycle ceiling vs the per-member allocation.
 */
export async function recordOverageAtCheckout(
  input: RecordOverageInput,
): Promise<void> {
  const {
    tx,
    programAssignmentId,
    utilization,
    bookingPricePaise: amount,
    currency,
    paymentId,
    userId,
    organizationId,
    paymentGateway,
  } = input;

  const isCredit = utilization.programType === "CREDIT_POOL";
  const programRow = await tx.program.findFirst({
    where: { assignments: { some: { id: programAssignmentId } } },
    select: {
      licensedSeatConfig: {
        select: {
          overageBehavior: true,
          priceCapPerEngagementPaise: true,
          coveredEngagementsPerCycle: true,
          overageSurchargeBps: true,
          maxOveragePerCyclePaise: true,
        },
      },
      creditPoolConfig: {
        select: {
          overageBehavior: true,
          overageSurchargeBps: true,
          maxOveragePerCyclePaise: true,
        },
      },
    },
  });
  const lsc = programRow?.licensedSeatConfig;
  const cpc = programRow?.creditPoolConfig;

  // Cycle overage-so-far. A ProgramAssignment is per-cycle, so every
  // OverageEvent on this assignmentId is already cycle-scoped. No settledAt
  // filter (a mid-cycle invoice run stamps settledAt but must not reset the
  // breaker); excludes REVERSED/BLOCKED/FAILED so a refunded/never-collected
  // overage frees the ceiling again.
  const soFarAgg = await tx.overageEvent.aggregate({
    where: {
      programAssignmentId,
      chargeStatus: { notIn: ["REVERSED", "BLOCKED", "FAILED"] },
    },
    _sum: { marginalPaise: true },
  });
  const cycleOverageSoFarPaise = sumPaise(soFarAgg._sum.marginalPaise);

  // Drive the decision through the shared computeOverageForBooking() mapper.
  // For LICENSED_SEAT the PRE-booking engagement count is needed (the meter
  // already applied this booking's delta); for CREDIT_POOL the PRE-booking
  // consumed paise. The preview surface (#777 §C) builds the same context from
  // the assignment's current state, so the two can't drift.
  const engagementsConsumed = Math.max(1, utilization.engagementsConsumedDelta);
  const overage = computeOverageForBooking(
    isCredit
      ? {
          programType: "CREDIT_POOL",
          overageBehavior: cpc?.overageBehavior ?? "BLOCK",
          maxOveragePerCyclePaise: cpc?.maxOveragePerCyclePaise ?? null,
          cycleOverageSoFarPaise,
          overageSurchargeBps: cpc?.overageSurchargeBps ?? null,
          creditBudgetPaise: utilization.creditBudgetPaise,
          consumedPaise: utilization.consumedPaiseAfter - amount,
        }
      : {
          programType: "LICENSED_SEAT",
          overageBehavior: lsc?.overageBehavior ?? "BLOCK",
          maxOveragePerCyclePaise: lsc?.maxOveragePerCyclePaise ?? null,
          cycleOverageSoFarPaise,
          overageSurchargeBps: lsc?.overageSurchargeBps ?? null,
          coveredEngagementsPerCycle: lsc?.coveredEngagementsPerCycle ?? null,
          engagementsUsed:
            utilization.engagementsUsedAfter -
            utilization.engagementsConsumedDelta,
          priceCapPerEngagementPaise: lsc?.priceCapPerEngagementPaise ?? null,
        },
    { bookingPricePaise: amount, engagementsConsumed },
  );
  const { marginalPaise, basePaise, surchargePaise } = overage;

  // Circuit breaker: ceiling exceeded → reject the booking like BLOCK. Distinct
  // code so the dashboard can explain it's the cycle cap, not the allocation.
  if (overage.decision === "BLOCK" && overage.chargeTo === null) {
    throw Object.assign(
      new Error(
        "PROGRAM_CAP_EXHAUSTED: This booking would exceed the program's per-cycle overage ceiling. Contact your organization administrator to raise the ceiling or wait for the next cycle.",
      ),
      { httpStatus: 402, code: "PROGRAM_CAP_EXHAUSTED" },
    );
  }

  if (marginalPaise <= 0) return;

  const bu = await tx.bookingUtilization.findUnique({
    where: { paymentId },
    select: { id: true },
  });
  if (!bu) return;

  if (overage.chargeTo === "MEMBER") {
    // Instant member charge. The booking proceeds; create a parent-linked
    // PENDING side-Payment for the marginal. The gateway is NOT called inside
    // this Serializable TX — the order is minted lazily when the member opens
    // the resume-checkout surface, and the webhook flips both → CHARGED.
    // `appointmentId: null` avoids the @@unique([userId, appointmentId]) clash.
    const sideCharge = await tx.payment.create({
      data: {
        amount: marginalPaise,
        originalAmount: marginalPaise,
        taxAmount: 0,
        currency,
        paymentMethod: "CARD",
        paymentIntent: `overage:${paymentId}`,
        paymentGateway,
        paymentStatus: PaymentStatus.PENDING,
        isMockPayment: false,
        userId,
        appointmentId: null,
        organizationId,
        parentPaymentId: paymentId,
      },
    });
    const memberOverageEvent = await tx.overageEvent.create({
      data: {
        programAssignmentId,
        bookingUtilizationId: bu.id,
        overageBehavior: "CHARGE_MEMBER",
        basePaise,
        surchargePaise,
        marginalPaise,
        // Mirrors the booking currency (the side-Payment + timeout notify
        // read it back); hardcoding INR mislabels a non-INR booking.
        currency,
        chargeStatus: "PENDING",
        paymentId: sideCharge.id,
      },
    });

    // #785 — carve the over-cap pass-through (basePaise) out of the org-funded
    // parent so the org pays only coveredPaise; the member side-charge above
    // (marginalPaise) covers the over-cap portion. Without this, basePaise is
    // collected TWICE — once in the parent's base leg, once in the member charge
    // (coveredPaise + basePaise == price). INVOICE accrual carves cleanly; a
    // WALLET-funded parent would also need a balance credit-back (not reachable
    // with current configs — no WALLET program charges overage).
    if (basePaise > 0) {
      const parentBase = await tx.paymentLeg.findUnique({
        where: { paymentId_source: { paymentId, source: "INVOICE_ACCRUAL" } },
        select: { amountPaise: true },
      });
      // Fail closed: if there's no INVOICE_ACCRUAL leg ≥ basePaise to carve from
      // (e.g. a WALLET/LICENSE-funded parent), basePaise was already collected via
      // that funding source and the member side-charge above bills it AGAIN. The
      // credit-back path for non-invoice parents isn't built (#715), so abort the
      // tx rather than silently double-collect basePaise. Reachable today because
      // isReachableOrgFundingPath doesn't constrain overageBehavior by funding.
      if (!parentBase || parentBase.amountPaise < basePaise) {
        throw new Error(
          `CHARGE_MEMBER overage on payment ${paymentId}: cannot carve basePaise=${basePaise} ` +
            `from parent INVOICE_ACCRUAL leg (${parentBase ? parentBase.amountPaise : "absent"}); ` +
            `non-invoice-funded member-overage credit-back not implemented (#715) — refusing to double-collect`,
        );
      }
      await tx.paymentLeg.update({
        where: { paymentId_source: { paymentId, source: "INVOICE_ACCRUAL" } },
        data: { amountPaise: { decrement: basePaise } },
      });
      await tx.payment.update({
        where: { id: paymentId },
        data: { amount: { decrement: basePaise } },
      });
    }

    // Tell the member they owe the marginal + deep-link to the pay surface.
    // Fire-and-forget on the outer prisma (committed-state lookup; not part of
    // this rolling-back-able tx).
    void prisma.programAssignment
      .findUnique({
        where: { id: programAssignmentId },
        select: {
          program: {
            select: {
              name: true,
              contract: {
                select: { organization: { select: { name: true } } },
              },
            },
          },
        },
      })
      .then((ctx) => {
        if (!ctx) return;
        return notifyOrgProgramOverageDue(userId, {
          orgName: ctx.program.contract.organization.name,
          programName: ctx.program.name,
          amountPaise: marginalPaise,
          payUrl: `/dashboard/overage?charge=${memberOverageEvent.id}`,
        });
      })
      .catch((notifyErr) =>
        console.error("[notifyOrgProgramOverageDue] failed:", notifyErr),
      );
    return;
  }

  if (overage.chargeTo === "ORG") {
    // #785 — the over-cap pass-through (basePaise) is ALREADY inside the base
    // INVOICE_ACCRUAL leg (coveredPaise + basePaise == price), and the rollup
    // sums BOTH leg sources into the invoice — so adding the overage leg on top
    // double-bills the org by basePaise (and breaks Σlegs == amount). Carve
    // basePaise OUT of the base leg into the explicit OVERAGE_INVOICE_ACCRUAL
    // leg; only the surcharge is genuinely-additional money (marginal == base +
    // surcharge). When no base INVOICE_ACCRUAL leg exists (wallet/license-funded)
    // nothing is carved and the overage is fully additive — `marginal − carved`
    // yields the right `amount` bump either way.
    const baseLeg = await tx.paymentLeg.findUnique({
      where: { paymentId_source: { paymentId, source: "INVOICE_ACCRUAL" } },
      select: { amountPaise: true },
    });
    const carved = baseLeg && baseLeg.amountPaise >= basePaise ? basePaise : 0;
    if (carved > 0) {
      await tx.paymentLeg.update({
        where: { paymentId_source: { paymentId, source: "INVOICE_ACCRUAL" } },
        data: { amountPaise: { decrement: carved } },
      });
    }
    // OVERAGE_INVOICE_ACCRUAL (distinct source) avoids the @@unique([paymentId,
    // source]) clash with the base leg; the rollup turns the event into an
    // InvoiceLineItem (PENDING → ACCRUED → CHARGED).
    await tx.paymentLeg.create({
      data: {
        paymentId,
        source: "OVERAGE_INVOICE_ACCRUAL",
        amountPaise: marginalPaise,
        sourceRef: `overage:${programAssignmentId}`,
      },
    });
    const amountDelta = marginalPaise - carved;
    if (amountDelta > 0) {
      await tx.payment.update({
        where: { id: paymentId },
        data: { amount: { increment: amountDelta } },
      });
    }
    await tx.overageEvent.create({
      data: {
        programAssignmentId,
        bookingUtilizationId: bu.id,
        overageBehavior: "CHARGE_ORG",
        basePaise,
        surchargePaise,
        marginalPaise,
        currency,
        chargeStatus: "PENDING",
        // paymentId / invoiceLineItemId / settledAt stamped by the rollup.
      },
    });
  }
}
