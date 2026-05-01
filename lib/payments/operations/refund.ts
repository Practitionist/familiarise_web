/**
 * Canonical Refund Operation (C1)
 *
 * Single entry point for app-initiated refunds. Replaces the ad-hoc
 * inline cascade logic that used to live in
 * `scripts/refunds/cascade-refund-earnings.ts` (which only handled
 * ConsultantEarnings and ignored OrganizationEarnings, the wallet,
 * BookingUtilization, PaymentLegs, and clawback).
 *
 * Two consumers:
 *
 *   1. `refundPayment(input)` — app-initiated (admin button, support
 *      tool). Creates the `Refund` row in PROCESSING, runs the cascade,
 *      flips it to SUCCEEDED. Use this when the refund originates inside
 *      the app and you want it gateway-bound + ledgered in one call.
 *
 *   2. `applyRefundCascade(tx, ...)` — gateway-initiated (Stripe /
 *      Razorpay webhook → `Refund` row already exists). The cascade
 *      cron in `scripts/refunds/cascade-refund-earnings.ts` calls this
 *      to fan out the side-effects without re-creating the Refund row.
 *
 * Both paths share the same proportional cascade so behaviour is
 * identical regardless of who started it.
 *
 * Cascade scope (all inside one Serializable tx):
 *   - PaymentLeg reversal — per-source side-effects (WALLET credit,
 *     INVOICE_ACCRUAL negative sibling leg or clawback, LICENSE program
 *     restore, CARD/REFERRAL_CREDIT no-op).
 *   - BookingUtilization reversal via `reverseBookingUtilization`.
 *   - ConsultantEarnings.refundedShareAmount += proportional.
 *   - OrganizationEarnings.refundedAmountPaise += proportional;
 *     OrganizationPayout clawback when already COMPLETED.
 *   - OrgAuditLog row in PAYOUT category.
 *
 * Proportional rounding: `floor(original * r)` per row, last leg /
 * earnings absorbs the remainder so the sum equals `amountPaise` to
 * the paise.
 */

import prisma from "@/lib/prisma";
import {
  EarningStatus,
  PaymentStatus,
  Prisma,
  RefundStatus,
} from "@prisma/client";

import { walletCredit } from "@/lib/api/organizations/wallet";
import { reverseBookingUtilization } from "@/lib/api/organizations/program-helpers";
import { assertEarningStatusTransitionLegal } from "@/lib/payments/payouts/earning-status";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

// ============================================================================
// Public types
// ============================================================================

export type RefundInput = {
  paymentId: string;
  /** Defaults to full remaining (Payment.amount − sum(existing refunds)). */
  amountPaise?: number;
  reason: string;
  /** For audit; staff/admin/customer userId. Optional — gateway-driven
   *  cascades pass null since there's no human actor. */
  initiatedByUserId?: string | null;
};

export type RefundResult = {
  refundId: string;
  amountRefundedPaise: number;
  legsReversed: number;
  consultantEarningsReversed: number;
  organizationEarningsReversed: number;
  clawbackInitiated: boolean;
};

export class RefundValidationError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = "RefundValidationError";
  }
}

// ============================================================================
// Orchestrator: app-initiated refund (creates Refund row + cascades)
// ============================================================================

/**
 * App-initiated refund. Creates a new Refund row inside the same
 * Serializable transaction as the cascade so a partial failure rolls
 * the whole thing back (no orphan Refund rows pointing at un-reversed
 * earnings).
 *
 * For gateway-initiated refunds (webhook → Refund already exists), use
 * `applyRefundCascade` directly — it takes the existing refundId.
 */
export async function refundPayment(input: RefundInput): Promise<RefundResult> {
  // Read payment outside the tx for early validation (cheap read; the
  // Serializable tx re-reads + locks for the actual mutation).
  const payment = await prisma.payment.findUnique({
    where: { id: input.paymentId },
    select: {
      id: true,
      amount: true,
      currency: true,
      paymentStatus: true,
      paymentGateway: true,
      displayCurrencyAtCheckout: true,
      exchangeRateAtCheckout: true,
      refunds: { select: { amount: true, status: true } },
    },
  });

  if (!payment) {
    throw new RefundValidationError(
      `Payment ${input.paymentId} not found`,
      "PAYMENT_NOT_FOUND",
    );
  }
  if (payment.paymentStatus !== PaymentStatus.SUCCEEDED) {
    throw new RefundValidationError(
      `Payment ${input.paymentId} is not SUCCEEDED (status=${payment.paymentStatus}); cannot refund`,
      "PAYMENT_NOT_SUCCEEDED",
    );
  }

  // Sum already-refunded across non-FAILED, non-CANCELLED refunds. A
  // FAILED gateway refund did not move money so it doesn't reduce the
  // refundable balance.
  const alreadyRefunded = payment.refunds
    .filter(
      (r) =>
        r.status === RefundStatus.SUCCEEDED ||
        r.status === RefundStatus.PENDING,
    )
    .reduce((acc, r) => acc + r.amount, 0);

  const refundable = payment.amount - alreadyRefunded;
  if (refundable <= 0) {
    throw new RefundValidationError(
      `Payment ${input.paymentId} already fully refunded (amount=${payment.amount}, alreadyRefunded=${alreadyRefunded})`,
      "ALREADY_FULLY_REFUNDED",
    );
  }

  const requested = input.amountPaise ?? refundable;
  if (requested <= 0) {
    throw new RefundValidationError(
      `Refund amount must be positive; got ${requested}`,
      "INVALID_AMOUNT",
    );
  }
  if (requested > refundable) {
    throw new RefundValidationError(
      `Refund amount ${requested} exceeds refundable ${refundable} on payment ${input.paymentId}`,
      "AMOUNT_EXCEEDS_REFUNDABLE",
    );
  }

  return prisma.$transaction(
    async (tx) => {
      // Re-derive `refundable` inside the Serializable tx — defends
      // against two refunds racing through the outer read.
      const refundsLocked = await tx.refund.findMany({
        where: {
          paymentId: input.paymentId,
          status: { in: [RefundStatus.SUCCEEDED, RefundStatus.PENDING] },
        },
        select: { amount: true },
      });
      const refundedNow = refundsLocked.reduce((a, r) => a + r.amount, 0);
      const remainingNow = payment.amount - refundedNow;
      if (requested > remainingNow) {
        throw new RefundValidationError(
          `Race-loss: refund amount ${requested} exceeds refundable ${remainingNow} on payment ${input.paymentId}`,
          "AMOUNT_EXCEEDS_REFUNDABLE",
        );
      }

      // Create the Refund row in PENDING (the schema's pre-success
      // state — there is no PROCESSING enum value). We use a synthetic
      // `refundId` keyed `app_<uuid>` so it's distinguishable from
      // gateway IDs (`re_xxx`/`rfnd_xxx`) and from the
      // reconciliation-script placeholders (`pending_xxx`). Callers
      // that bind to a real gateway refund (Stripe `re_xxx`) should
      // update this row's `refundId` after the gateway call returns.
      const created = await tx.refund.create({
        data: {
          paymentId: input.paymentId,
          amount: requested,
          currency: payment.currency,
          reason: input.reason,
          status: RefundStatus.PENDING,
          refundId: `app_${globalThis.crypto.randomUUID()}`,
          paymentGateway: payment.paymentGateway,
          exchangeRateAtRefund: payment.exchangeRateAtCheckout,
          displayCurrency: payment.displayCurrencyAtCheckout,
          metadata: {
            initiatedByUserId: input.initiatedByUserId ?? null,
            source: "app",
          } as Prisma.InputJsonValue,
        },
      });

      const cascade = await applyRefundCascade(tx, {
        paymentId: input.paymentId,
        refundId: created.id,
        amountPaise: requested,
        reason: input.reason,
        initiatedByUserId: input.initiatedByUserId ?? null,
      });

      await tx.refund.update({
        where: { id: created.id },
        data: { status: RefundStatus.SUCCEEDED },
      });

      return {
        refundId: created.id,
        amountRefundedPaise: requested,
        ...cascade,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

// ============================================================================
// Inner cascade: shared by app + webhook flows
// ============================================================================

export type ApplyRefundCascadeInput = {
  paymentId: string;
  refundId: string;
  amountPaise: number;
  reason: string;
  initiatedByUserId?: string | null;
};

export type ApplyRefundCascadeResult = {
  legsReversed: number;
  consultantEarningsReversed: number;
  organizationEarningsReversed: number;
  clawbackInitiated: boolean;
};

/**
 * Inner cascade — runs steps 4–8 of the refund operation against an
 * already-existing Refund row. Caller must pass a transaction client;
 * the cascade itself has no `prisma.$transaction` wrapper because it is
 * meant to compose with the caller's tx (Serializable required for
 * race-safety).
 */
export async function applyRefundCascade(
  tx: Prisma.TransactionClient,
  input: ApplyRefundCascadeInput,
): Promise<ApplyRefundCascadeResult> {
  const payment = await tx.payment.findUniqueOrThrow({
    where: { id: input.paymentId },
    include: {
      legs: { orderBy: { createdAt: "asc" } },
      earnings: true,
      organizationEarnings: { include: { orgPayout: true } },
      bookingUtilization: true,
    },
  });

  if (payment.amount <= 0) {
    // Zero-amount payments (LICENSE-only) have no money to refund.
    // Still reverse the booking utilization so the seat returns.
    if (payment.bookingUtilization) {
      await reverseBookingUtilization(tx, {
        paymentId: payment.id,
        reason: input.reason,
      });
    }
    return {
      legsReversed: 0,
      consultantEarningsReversed: 0,
      organizationEarningsReversed: 0,
      clawbackInitiated: false,
    };
  }

  // Proportional ratio expressed as numerator/denominator so we can do
  // exact integer math (no float drift on large amounts).
  const num = input.amountPaise;
  const den = payment.amount;
  const proportion = (original: number): number =>
    Math.floor((original * num) / den);

  // -----------------------------------------------------------------------
  // Step 4: Reverse PaymentLegs proportionally with last-leg-absorbs-remainder.
  // -----------------------------------------------------------------------
  let legsReversed = 0;
  const legAmounts: Array<{ leg: (typeof payment.legs)[number]; reverse: number }> =
    payment.legs
      .filter((l) => l.amountPaise > 0) // negative refund legs already in place
      .map((leg) => ({ leg, reverse: proportion(leg.amountPaise) }));

  if (legAmounts.length > 0) {
    const totalAssigned = legAmounts.reduce((a, l) => a + l.reverse, 0);
    const remainder = input.amountPaise - totalAssigned;
    // Scope the remainder pickup to the legs we actually reversed (the
    // CARD/WALLET/INVOICE_ACCRUAL legs). LICENSE legs are zero-value and
    // don't participate in the proportional split.
    const positiveLegs = legAmounts.filter((l) => l.leg.amountPaise > 0);
    if (positiveLegs.length > 0) {
      positiveLegs[positiveLegs.length - 1].reverse += remainder;
    }
  }

  for (const { leg, reverse } of legAmounts) {
    if (reverse <= 0) continue;
    legsReversed++;

    switch (leg.source) {
      case "WALLET": {
        // Credit the wallet back. `walletCredit` requires a
        // BillingAccount on the payment — checkout always sets one for
        // WALLET-funded payments.
        if (!payment.billingAccountId) {
          throw new Error(
            `Payment ${payment.id} has WALLET leg ${leg.id} but no billingAccountId; cannot credit refund`,
          );
        }
        await walletCredit(tx, {
          billingAccountId: payment.billingAccountId,
          amountPaise: reverse,
          reason: "REFUND",
          paymentId: payment.id,
          notes: `Refund cascade: ${input.reason}`,
        });
        break;
      }

      case "INVOICE_ACCRUAL": {
        // If the parent invoice is already PAID, the refund must be
        // clawed back from the org (handled at the OrganizationEarnings
        // level below); do NOT write a negative leg, because that would
        // break the leg-sum invariant on a settled invoice. If the
        // invoice is still pending (or the payment isn't tied to an
        // invoice yet), reduce the accrual by appending a negative
        // sibling leg so the rollup picks up the smaller amount.
        const billable = payment.billableToOrgInvoiceId
          ? await tx.organizationInvoice.findUnique({
              where: { id: payment.billableToOrgInvoiceId },
              select: { status: true },
            })
          : null;
        const alreadyBilled = billable?.status === "PAID";
        if (!alreadyBilled) {
          await tx.paymentLeg.create({
            data: {
              paymentId: payment.id,
              source: "INVOICE_ACCRUAL",
              amountPaise: -reverse,
              sourceRef: leg.sourceRef,
            },
          });
        }
        // else: clawback handled below in OrganizationEarnings step.
        break;
      }

      case "LICENSE": {
        // Restore engagements on the program assignment. The booking
        // utilization handles the engagementsUsed counter +
        // UsageLedgerEntry, so we just defer to it (called once at the
        // end of step 5, not per leg).
        break;
      }

      case "CARD":
      case "REFERRAL_CREDIT": {
        // CARD: gateway handles the actual money via the Refund row.
        // REFERRAL_CREDIT: TODO (v2) — referral credits do not
        // auto-restore on refund. Manual support intervention only;
        // tracking issue for the v2 referral ledger.
        break;
      }

      default: {
        // Exhaustive — adding a new PaymentLegSource without updating
        // this switch is a compile-time error.
        const _exhaustive: never = leg.source;
        throw new Error(`Unhandled PaymentLegSource: ${String(_exhaustive)}`);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Step 5: BookingUtilization reversal (proportional engagements).
  // -----------------------------------------------------------------------
  if (payment.bookingUtilization) {
    const u = payment.bookingUtilization;
    // Proportional reversal in engagement units. Round up so a partial
    // refund of half a booking still releases at least 1 engagement (we
    // can't release "half a seat"). For full refunds this naturally
    // releases everything.
    const engagementsToReverse =
      input.amountPaise === payment.amount
        ? u.engagementsConsumed
        : Math.max(
            1,
            Math.ceil((u.engagementsConsumed * input.amountPaise) / payment.amount),
          );
    await reverseBookingUtilization(tx, {
      paymentId: payment.id,
      reason: input.reason,
      engagementsToReverse,
    });
  }

  // -----------------------------------------------------------------------
  // Step 6: ConsultantEarnings reversal.
  // -----------------------------------------------------------------------
  let consultantEarningsReversed = 0;
  for (const earnings of payment.earnings) {
    const shareReversal = proportion(earnings.consultantShare);
    if (shareReversal <= 0) continue;
    const newRefundedShare = earnings.refundedShareAmount + shareReversal;
    const fully = newRefundedShare >= earnings.consultantShare;

    let nextStatus = earnings.status;
    if (fully && earnings.status !== EarningStatus.REFUNDED) {
      // Guard the transition. PAID → REFUNDED is allowed; other
      // sources (PENDING/HELD/READY/PENDING_TRUST) → REFUNDED is
      // implicitly allowed by the guard. The guard rejects
      // REFUNDED→anything (already-terminal), which we skip via the
      // outer `!== REFUNDED` check.
      assertEarningStatusTransitionLegal(
        earnings.id,
        earnings.status,
        EarningStatus.REFUNDED,
      );
      nextStatus = EarningStatus.REFUNDED;
    }

    await tx.consultantEarnings.update({
      where: { id: earnings.id },
      data: {
        refundedShareAmount: newRefundedShare,
        status: nextStatus,
      },
    });
    consultantEarningsReversed++;
  }

  // -----------------------------------------------------------------------
  // Step 7: OrganizationEarnings reversal + clawback.
  // -----------------------------------------------------------------------
  let organizationEarningsReversed = 0;
  let clawbackInitiated = false;

  for (const orgEarn of payment.organizationEarnings) {
    // Reverse the gross share owed back: org share + consultant share
    // proportions. (We do NOT include platformFee here — the platform
    // pockets nothing on a fully-refunded transaction; that side of the
    // ledger is accounted for at settlement / TDS.)
    const orgShareRev = proportion(orgEarn.orgSharePaise);
    const consShareRev = proportion(orgEarn.consultantSharePaise);
    const totalRev = orgShareRev + consShareRev;
    if (totalRev <= 0) continue;

    const newRefunded = orgEarn.refundedAmountPaise + totalRev;
    // "Fully refunded" compares against the refundable portion of the
    // earnings — the org + consultant shares — NOT the gross. The
    // platform fee is the platform's revenue and is never returned to
    // the consumer (the platform absorbs the gateway fee + own cut).
    // Keying the status flip off `grossAmountPaise` would leave fully-
    // settled earnings stuck in PENDING because totalRev maxes out at
    // (orgShare + consultantShare).
    const refundableCeiling =
      orgEarn.orgSharePaise + orgEarn.consultantSharePaise;
    const fully = newRefunded >= refundableCeiling;

    let nextStatus = orgEarn.status;
    if (fully && orgEarn.status !== EarningStatus.REFUNDED) {
      assertEarningStatusTransitionLegal(
        orgEarn.id,
        orgEarn.status,
        EarningStatus.REFUNDED,
      );
      nextStatus = EarningStatus.REFUNDED;
    }

    await tx.organizationEarnings.update({
      where: { id: orgEarn.id },
      data: {
        refundedAmountPaise: newRefunded,
        status: nextStatus,
      },
    });
    organizationEarningsReversed++;

    // Clawback: if this earnings row was already rolled into a payout
    // and that payout is COMPLETED (bank wire left), record the
    // clawback on the payout itself. Manual recovery only in v1.
    if (
      orgEarn.orgPayoutId &&
      orgEarn.orgPayout?.status === "COMPLETED" &&
      orgShareRev > 0
    ) {
      await tx.organizationPayout.update({
        where: { id: orgEarn.orgPayoutId },
        data: {
          clawbackAmountPaise: { increment: orgShareRev },
          // Only stamp on the FIRST clawback — preserves the
          // earliest-clawback timestamp across multiple partial
          // refunds against the same payout.
          clawbackInitiatedAt: orgEarn.orgPayout.clawbackInitiatedAt
            ? undefined
            : new Date(),
        },
      });

      await tx.orgAuditLog.create({
        data: {
          organizationId: orgEarn.organizationId,
          actorMembershipId: null,
          category: "PAYOUT",
          action: AUDIT_ACTIONS.PAYOUT.PAYOUT_CLAWBACK,
          description: `Refund clawback initiated: ${orgShareRev} paise from payout ${orgEarn.orgPayoutId}`,
          details: {
            paymentId: payment.id,
            refundId: input.refundId,
            orgEarningsId: orgEarn.id,
            orgPayoutId: orgEarn.orgPayoutId,
            amountPaise: input.amountPaise,
            clawbackAmountPaise: orgShareRev,
            initiatedByUserId: input.initiatedByUserId ?? null,
          } as Prisma.InputJsonValue,
        },
      });

      clawbackInitiated = true;
    }
  }

  // -----------------------------------------------------------------------
  // Step 8: General audit row (only when we did NOT already write a
  // clawback row above for the same org — keeps the audit log focused).
  // For payments tagged with an `organizationId` we still want a
  // category: INVOICE row so the org-side audit feed shows the refund.
  // -----------------------------------------------------------------------
  if (payment.organizationId && !clawbackInitiated) {
    await tx.orgAuditLog.create({
      data: {
        organizationId: payment.organizationId,
        actorMembershipId: null,
        category: "INVOICE",
        action: AUDIT_ACTIONS.INVOICE.INVOICE_REFUNDED,
        description: `Refund ${input.refundId} processed: ${input.amountPaise} paise`,
        details: {
          paymentId: payment.id,
          refundId: input.refundId,
          amountPaise: input.amountPaise,
          reason: input.reason,
          initiatedByUserId: input.initiatedByUserId ?? null,
        } as Prisma.InputJsonValue,
      },
    });
  }

  return {
    legsReversed,
    consultantEarningsReversed,
    organizationEarningsReversed,
    clawbackInitiated,
  };
}
