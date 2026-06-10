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

import prisma, { type Tx } from "@/lib/prisma";
import {
  EarningStatus,
  type LedgerAccountKind,
  PaymentStatus,
  Prisma,
  RefundStatus,
} from "@prisma/client";

import { walletCredit } from "@/lib/api/organizations/wallet";
import { reverseBookingUtilization } from "@/lib/api/organizations/program-helpers";
import { assertEarningStatusTransitionLegal } from "@/lib/payments/payouts/earning-status";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { postLedgerTxn, type Posting } from "@/lib/payments/ledger/post";
import { recordTdsReversal } from "@/lib/payments/tax/tds-service";
import { generateOrgCreditNoteNumber } from "@/lib/payments/billing/credit-note-numbering";
import { recordSystemError } from "@/lib/enterprise/system-events";
import { sumPaise } from "@/lib/payments/utils/money";

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
  constructor(
    message: string,
    public code: string,
  ) {
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
      refunds: { select: { amountPaise: true, status: true } },
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
  const refundedSoFar = payment.refunds
    .filter(
      (r) =>
        r.status === RefundStatus.SUCCEEDED ||
        r.status === RefundStatus.PENDING,
    )
    .reduce((acc, r) => acc + r.amountPaise, 0);

  // #785 — also count money already pulled via a lost chargeback on this
  // payment. Two reasons, both correct for ALL payments (org AND B2C), so this
  // is deliberately NOT scoped to organizationId like applyOrgChargeback is:
  //   - org-funded: pairs with applyOrgChargeback so the org isn't debited twice
  //     (refund reversal + chargeback debit) for one reversal.
  //   - B2C: a LOST dispute means the bank already returned the money to the
  //     customer; an app refund on top would return it twice (platform loss).
  // A partial dispute still leaves the un-disputed remainder refundable.
  const chargedBackAgg = await prisma.dispute.aggregate({
    where: {
      paymentId: input.paymentId,
      status: { in: ["LOST", "CHARGE_REFUNDED"] },
    },
    _sum: { amountPaise: true },
  });
  const chargedBack = sumPaise(chargedBackAgg._sum.amountPaise);
  const alreadyRefunded = refundedSoFar + chargedBack;

  const refundable = payment.amount - alreadyRefunded;
  if (refundable <= 0) {
    throw new RefundValidationError(
      `Payment ${input.paymentId} has no refundable balance (amount=${payment.amount}, ` +
        `refunded=${refundedSoFar}, chargeback-reversed=${chargedBack}); the customer was ` +
        `already made whole — a chargeback returns money via the bank, not an app refund`,
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
      // against two refunds racing through the outer read. Must mirror the
      // outer computation EXACTLY (refunds + lost chargebacks): the outer
      // read also nets disputes, and a chargeback can commit between the
      // outer read and here. Reading the dispute table inside this
      // Serializable tx makes SSI abort the loser when a lost-chargeback tx
      // (also Serializable, see handleDisputeUpdated) interleaves — closing
      // the refund×chargeback double-reversal the netting was added to fix.
      const refundsLocked = await tx.refund.findMany({
        where: {
          paymentId: input.paymentId,
          status: { in: [RefundStatus.SUCCEEDED, RefundStatus.PENDING] },
        },
        select: { amountPaise: true },
      });
      const refundedNow = refundsLocked.reduce((a, r) => a + r.amountPaise, 0);
      const chargedBackNow = await tx.dispute.aggregate({
        where: {
          paymentId: input.paymentId,
          status: { in: ["LOST", "CHARGE_REFUNDED"] },
        },
        _sum: { amountPaise: true },
      });
      const remainingNow =
        payment.amount -
        refundedNow -
        sumPaise(chargedBackNow._sum.amountPaise);
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
          amountPaise: requested,
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
  tx: Tx,
  input: ApplyRefundCascadeInput,
): Promise<ApplyRefundCascadeResult> {
  // #776 — atomic idempotency claim. Exactly one caller flips `cascadedAt`
  // null→now; an overlapping gateway-webhook + backstop-cron (or a redelivery)
  // sees count===0 and no-ops. The row lock on this conditional update serializes
  // concurrent claimers under any isolation, so the cascade — wallet credit, leg
  // reversal, earnings increments, clawback — never double-applies. If the cascade
  // throws below, the whole tx rolls back and the claim reverts for a clean retry.
  const claim = await tx.refund.updateMany({
    where: { id: input.refundId, cascadedAt: null },
    data: { cascadedAt: new Date() },
  });
  if (claim.count === 0) {
    return {
      legsReversed: 0,
      consultantEarningsReversed: 0,
      organizationEarningsReversed: 0,
      clawbackInitiated: false,
    };
  }

  const payment = await tx.payment.findUniqueOrThrow({
    where: { id: input.paymentId },
    include: {
      legs: { orderBy: { createdAt: "asc" } },
      // #813 — the scalar `earnings.payoutId` is all the TDS-reversal helper needs
      // to find the original TDSRecord; the prior `payout` TDS-field include was
      // dead (review finding).
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
  // legAmounts holds only positive legs — LICENSE/zero-value legs are excluded
  // here so they never skew the proportional split.
  const legAmounts: Array<{
    leg: (typeof payment.legs)[number];
    reverse: number;
  }> = payment.legs
    .filter((l) => l.amountPaise > 0) // negative refund legs already in place
    .map((leg) => ({ leg, reverse: proportion(leg.amountPaise) }));

  if (legAmounts.length > 0) {
    const totalAssigned = legAmounts.reduce((a, l) => a + l.reverse, 0);
    const remainder = input.amountPaise - totalAssigned;
    // Last reversed leg absorbs the floor remainder so the legs sum to exactly
    // input.amountPaise (#776).
    legAmounts[legAmounts.length - 1].reverse += remainder;
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

      case "INVOICE_ACCRUAL":
      case "OVERAGE_INVOICE_ACCRUAL": {
        // Both base and overage accrual legs share the same reversal
        // semantics: if the invoice is already PAID, clawback is handled
        // at the OrganizationEarnings level below (mutating the leg of a
        // settled invoice would diverge from the issued document).
        //
        // #786/#781 §B — funding legs are append-only: the original leg is
        // never mutated; the refund nets through a negative *_REVERSAL
        // sibling. One reversal leg per source keeps @@unique([paymentId,
        // source]) intact; subsequent partial refunds decrement the
        // existing reversal leg. The monthly rollup sums original +
        // reversal so it bills the net — and the full funding history
        // stays readable from the legs.
        const billable = payment.billableToOrgInvoiceId
          ? await tx.organizationInvoice.findUnique({
              where: { id: payment.billableToOrgInvoiceId },
              select: { status: true },
            })
          : null;
        const alreadyBilled = billable?.status === "PAID";
        if (!alreadyBilled) {
          const reversalSource =
            leg.source === "INVOICE_ACCRUAL"
              ? ("INVOICE_ACCRUAL_REVERSAL" as const)
              : ("OVERAGE_INVOICE_ACCRUAL_REVERSAL" as const);
          await tx.paymentLeg.upsert({
            where: {
              paymentId_source: {
                paymentId: payment.id,
                source: reversalSource,
              },
            },
            create: {
              paymentId: payment.id,
              source: reversalSource,
              amountPaise: -reverse,
              sourceRef: leg.sourceRef,
            },
            update: { amountPaise: { decrement: reverse } },
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

      case "INVOICE_ACCRUAL_REVERSAL":
      case "OVERAGE_INVOICE_ACCRUAL_REVERSAL": {
        // Unreachable: reversal legs are negative and legAmounts filters
        // on amountPaise > 0. Cases exist for switch exhaustiveness.
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
            Math.ceil(
              (u.engagementsConsumed * input.amountPaise) / payment.amount,
            ),
          );
    await reverseBookingUtilization(tx, {
      paymentId: payment.id,
      reason: input.reason,
      engagementsToReverse,
      // #776 — reverse the money-meter in proportion to the refund, not the
      // ceil'd engagement count (REFUND_BOOKING_COHERENCE).
      refundRatio: {
        refundAmountPaise: input.amountPaise,
        paymentAmountPaise: payment.amount,
      },
    });
  }

  // -----------------------------------------------------------------------
  // Step 6: ConsultantEarnings reversal.
  // -----------------------------------------------------------------------
  let consultantEarningsReversed = 0;
  for (const earnings of payment.earnings) {
    const shareReversal = proportion(earnings.consultantSharePaise);
    if (shareReversal <= 0) continue;
    // #785 — cap at the share (mirrors the credit-note Math.min + earnings-service):
    // a second reversal (e.g. app refund THEN a lost-dispute chargeback creates a
    // new Refund → new cascadedAt → Step 6 re-runs) would otherwise inflate
    // refundedShareAmount past consultantSharePaise and corrupt readyAmount/over-refund math.
    const newRefundedShare = Math.min(
      earnings.consultantSharePaise,
      earnings.refundedShareAmount + shareReversal,
    );
    const fully = newRefundedShare >= earnings.consultantSharePaise;

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

    // #813 — refund-driven TDS reversal for an already-paid-out earning, so the
    // quarterly 26Q nets the withholding back out. Previously only admin
    // forceRefund (earnings-service.ts) did this; a normal gateway/cron refund
    // left the TDS un-reversed. The shared helper owns the integer proportion,
    // the dedup/cap against double-reversal, and the filed-aware FY/quarter
    // policy (pending CA sign-off).
    if (earnings.payoutId) {
      await recordTdsReversal(tx, {
        payoutId: earnings.payoutId,
        consultantProfileId: earnings.consultantProfileId,
        earningsId: earnings.id,
        refundAmountPaise: input.amountPaise,
        paymentAmountPaise: payment.amount,
        refundId: input.refundId,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Step 7: OrganizationEarnings reversal + clawback.
  // -----------------------------------------------------------------------
  let organizationEarningsReversed = 0;
  let clawbackInitiated = false;

  for (const orgEarn of payment.organizationEarnings) {
    // #776 — `refundedAmountPaise` tracks the ORG-SHARE portion only. The
    // org-payout readyAmount nets it against `orgSharePaise`
    // (org-payout-service.ts), and the consultant slice is tracked separately on
    // `ConsultantEarnings.refundedShareAmount`. Incrementing by org+consultant
    // here double-counts the consultant slice and under-pays the org (or drives
    // readyAmount negative, blocking the whole batch) — and it diverged from the
    // gateway-refund path (`refundEarnings`), which already reverses org-share
    // only. `floor` proportion matches the leg/consultant reversals to the paise.
    const orgShareRev = proportion(orgEarn.orgSharePaise);
    if (orgShareRev <= 0) continue;

    // #789 review — cap at the org share, mirroring the ConsultantEarnings
    // Math.min above. A second reversal against the same row (e.g. an app refund
    // followed by a lost-dispute chargeback that mints a fresh Refund) would
    // otherwise inflate refundedAmountPaise past orgSharePaise and drive the
    // payout readyAmount negative, blocking the whole batch.
    const newRefunded = Math.min(
      orgEarn.orgSharePaise,
      orgEarn.refundedAmountPaise + orgShareRev,
    );
    // Fully refunded when the org share is exhausted — its sole refundable
    // portion (platform fee + consultant share are not org receivables).
    const fully = newRefunded >= orgEarn.orgSharePaise;

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
  // Step 7.5 (#776 / #778 §D): mint a GST credit note for the invoiced portion.
  // Extracted to `mintRefundCreditNote` so the gateway-refund webhook path
  // (which bypasses this cascade) can mint the same artifact — credit-note
  // issuance is a self-contained, idempotent piece, unlike earnings/TDS/leg
  // reversal. Idempotent on refundId, so calling it from both paths (or a cron
  // retry) is safe.
  // -----------------------------------------------------------------------
  await mintRefundCreditNote(tx, {
    paymentId: payment.id,
    refundId: input.refundId,
    amountPaise: input.amountPaise,
    reason: input.reason,
  });

  // #738-A — TCS u/s 52 parity: if collection ever stamped this payment
  // (flag-gated, schema-live), the refund must net it out of the next GSTR-8.
  // Inert while gstTcsCollectedPaise stays null. Idempotency rides on the
  // cascade's own exactly-once discipline (cascadedAt), not a unique here —
  // partial refunds legitimately produce one adjustment per refund.
  if ((payment.gstTcsCollectedPaise ?? 0) > 0) {
    const tcsReverse = Math.floor(
      (payment.gstTcsCollectedPaise! * input.amountPaise) / payment.amount,
    );
    if (tcsReverse > 0) {
      await tx.gstTcsAdjustment.create({
        data: {
          paymentId: payment.id,
          refundId: input.refundId,
          amountPaise: -tcsReverse,
          reason: `refund (${input.reason})`,
        },
      });
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

  // -----------------------------------------------------------------------
  // Step 9 (#771 P0-5): double-entry reversal (dual-write). A refund reverses
  // recognized revenue / payable / GST and returns the funding to its source.
  // Balanced by construction — PLATFORM_FEE absorbs the rounding/discount plug.
  // Wrapped so a ledger imbalance can never block the refund during dual-write.
  // -----------------------------------------------------------------------
  try {
    const orgId = payment.organizationId ?? null;
    const credits: Posting[] = [];
    for (const { leg, reverse } of legAmounts) {
      if (reverse <= 0) continue;
      let kind: LedgerAccountKind | null = null;
      let organizationId: string | null = null;
      switch (leg.source) {
        case "CARD":
          kind = "CASH";
          break;
        case "WALLET":
          kind = "WALLET";
          organizationId = orgId;
          break;
        case "INVOICE_ACCRUAL":
        case "OVERAGE_INVOICE_ACCRUAL":
          kind = "ORG_RECEIVABLE";
          organizationId = orgId;
          break;
        case "REFERRAL_CREDIT":
          kind = "PLATFORM_PROMO";
          break;
        case "LICENSE":
          break;
      }
      if (kind) {
        credits.push({
          account: { kind, organizationId },
          direction: "CREDIT",
          amountPaise: reverse,
        });
      }
    }
    const fundingTotal = credits.reduce((s, c) => s + c.amountPaise, 0);
    if (fundingTotal > 0) {
      const consRev = payment.earnings.reduce(
        (s, e) => s + proportion(e.consultantSharePaise),
        0,
      );
      const orgRev = payment.organizationEarnings.reduce(
        (s, o) => s + proportion(o.orgSharePaise),
        0,
      );
      // #812 — default a missing taxAmount to 0. A `null`/`undefined` here would
      // make gstRev NaN → the platform plug NaN → the posting silently lose a leg
      // and (now that the ledger blocks) roll the whole refund back. taxAmount
      // defaults to 0 in the schema, but legacy/imported rows may lack it.
      const gstRev = proportion(payment.taxAmount ?? 0);
      // #775 — a CHARGE_MEMBER side-payment refund: the member's capture
      // credited ORG_PAYABLE (overage:<paymentId> txn), so refunding it must
      // pull that relief credit BACK from the org — not bill the platform.
      // Without this branch the side-payment has no earnings, the whole
      // fundingTotal lands in platformPlug, and the org keeps money that
      // belongs to the member.
      const overageCapture = payment.parentPaymentId
        ? await tx.ledgerTransaction.findUnique({
            where: { idempotencyKey: `overage:${payment.id}` },
            select: { id: true },
          })
        : null;
      // #776 — PLATFORM_FEE is the residual: on a full refund it equals the
      // booking's fee exactly; on a partial refund it absorbs the ≤3-paise
      // floor remainder of the other shares (the platform absorbs rounding).
      // Invariant-safe — EARNINGS_LEDGER_DRIFT reconciles BOOKING postings, not
      // REFUND ones — so this never drifts the audited fee. Keep as a single
      // plug: no separately-signed account is a correct home for the remainder.
      const platformPlug = fundingTotal - consRev - orgRev - gstRev;
      const debits: Posting[] = [];
      if (platformPlug > 0) {
        if (overageCapture && orgId) {
          debits.push({
            account: { kind: "ORG_PAYABLE", organizationId: orgId },
            direction: "DEBIT",
            amountPaise: platformPlug,
          });
        } else {
          // Funding returned exceeds the reversed shares → platform gives back
          // its fee portion.
          debits.push({
            account: { kind: "PLATFORM_FEE" },
            direction: "DEBIT",
            amountPaise: platformPlug,
          });
        }
      }
      // #812 — debit each collaborator's own CONSULTANT_PAYABLE by its reversed
      // share, mirroring the per-collaborator credits the booking journal posts
      // (earnings-service.ts). The old code summed every share into consRev and
      // debited it all to the OWNER's account, which balanced the transaction but
      // left collaborators' payables un-reversed in the ledger — an invisible
      // per-account divergence on every multi-collaborator refund.
      for (const earning of payment.earnings) {
        const earningRev = proportion(earning.consultantSharePaise);
        if (earningRev > 0) {
          debits.push({
            account: {
              kind: "CONSULTANT_PAYABLE",
              consultantProfileId: earning.consultantProfileId,
            },
            direction: "DEBIT",
            amountPaise: earningRev,
          });
        }
      }
      if (orgRev > 0 && orgId) {
        debits.push({
          account: { kind: "ORG_PAYABLE", organizationId: orgId },
          direction: "DEBIT",
          amountPaise: orgRev,
        });
      }
      if (gstRev > 0) {
        debits.push({
          account: { kind: "GST_PAYABLE" },
          direction: "DEBIT",
          amountPaise: gstRev,
        });
      }
      if (platformPlug < 0) {
        // Reversed shares exceed the funding returned (rounding / discount /
        // referral-credit-funded portion). #778 §C residual policy: PLATFORM_FEE
        // absorbs the shortfall so the reversal is ALWAYS balanced. The prior
        // `platformPlug >= 0` guard silently dropped the posting on this path,
        // diverging earnings from the ledger irreparably (reconcile flagged
        // EARNINGS_LEDGER_DRIFT it could not repair).
        credits.push({
          account: { kind: "PLATFORM_FEE" },
          direction: "CREDIT",
          amountPaise: -platformPlug,
        });
      }
      const debitTotal = debits.reduce((s, d) => s + d.amountPaise, 0);
      const creditTotal = credits.reduce((s, c) => s + c.amountPaise, 0);
      if (debits.length > 0) {
        if (debitTotal !== creditTotal) {
          // Unreachable given the plug — a mismatch is a real logic bug. Surface
          // it (caught + logged below; reconcile flags it) instead of letting a
          // fall-through silently skip the reversal.
          throw new Error(
            `refund reversal unbalanced: Dr ${debitTotal} Cr ${creditTotal}`,
          );
        }
        await postLedgerTxn(tx, {
          idempotencyKey: `refund:${input.refundId}`,
          kind: "REFUND",
          paymentId: payment.id,
          postings: [...debits, ...credits],
        });
      }
    }
  } catch (err) {
    // #812 — the refund cascade runs inside the caller's tx, so a ledger
    // imbalance must roll the whole cascade back rather than half-applying the
    // earnings/leg reversals with no balanced journal. Record the drift on its
    // own connection (survives rollback), then RE-THROW. Callers (the cron / the
    // gateway webhook) retry the refund, so the customer refund is not lost — it
    // is re-driven atomically.
    console.error(
      `[ledger] refund reversal posting FAILED for payment ${payment.id} — rolling back the cascade: ${err instanceof Error ? err.message : String(err)}`,
    );
    void recordSystemError({
      organizationId: payment.organizationId ?? null,
      category: "LEDGER",
      summary: `Refund reversal ledger posting failed for payment ${payment.id}`,
      err,
      context: { paymentId: payment.id, refundId: input.refundId },
    }).catch(() => {});
    throw err;
  }

  return {
    legsReversed,
    consultantEarningsReversed,
    organizationEarningsReversed,
    clawbackInitiated,
  };
}

// ============================================================================
// Credit-note minting (#776 / #778 §D) — shared by the cascade + webhook
// ============================================================================

/**
 * Mint a GST credit note (CGST Sec 34 / Rule 53) for the invoiced portion of a
 * refund. Self-contained (loads its own data) and **idempotent on refundId**,
 * so it's safe to call from BOTH `applyRefundCascade` (app/cron-initiated) and
 * the gateway-refund webhook (which bypasses the cascade) — exactly once per
 * refund regardless of webhook redelivery or cron retry.
 *
 * Only the credit note is shared this way: it's a standalone artifact that
 * doesn't depend on funding-source reversal having happened. The double-entry
 * refund ledger posting and leg/wallet reversal are NOT shared here — those are
 * coupled to actual money movement the legacy webhook path doesn't perform, and
 * reproducing them there would risk WALLET_BALANCE_DRIFT (tracked separately).
 *
 * No-op (returns null) for non-invoiced payments. Must run inside a tx.
 */
export async function mintRefundCreditNote(
  tx: Tx,
  params: {
    paymentId: string;
    amountPaise: number;
    reason: string;
    // #738-B — exactly one trigger keys the note: a Refund (app/gateway
    // refund) or a Dispute (chargeback LOST). Both are @unique on
    // CreditNote, so each path is idempotent independently.
    refundId?: string;
    disputeId?: string;
  },
): Promise<{ creditNoteId: string | null }> {
  if (!params.refundId === !params.disputeId) {
    throw new Error(
      "mintRefundCreditNote: exactly one of refundId/disputeId must be set",
    );
  }
  const payment = await tx.payment.findUnique({
    where: { id: params.paymentId },
    select: {
      id: true,
      amount: true,
      organizationId: true,
      billableToOrgInvoiceId: true,
      legs: { select: { source: true, amountPaise: true } },
    },
  });
  if (
    !payment ||
    !payment.billableToOrgInvoiceId ||
    !payment.organizationId ||
    payment.amount <= 0
  ) {
    return { creditNoteId: null };
  }

  // Idempotency: one credit note per trigger (refundId/disputeId @unique).
  // Probe first so a replay returns the existing note instead of throwing on
  // the constraint (and never burns a gapless sequence number).
  const existing = await tx.creditNote.findUnique({
    where: params.refundId
      ? { refundId: params.refundId }
      : { disputeId: params.disputeId! },
    select: { id: true },
  });
  if (existing) return { creditNoteId: existing.id };

  // Proportional reversal of the invoice-accrual legs (no remainder-absorb —
  // a credit note is a tax document; strict proportion is correct).
  const proportion = (original: number): number =>
    Math.floor((original * params.amountPaise) / payment.amount);
  const invoicedReverse = payment.legs
    .filter(
      (l) =>
        l.source === "INVOICE_ACCRUAL" ||
        l.source === "OVERAGE_INVOICE_ACCRUAL",
    )
    .reduce((s, l) => s + Math.max(proportion(l.amountPaise), 0), 0);
  if (invoicedReverse <= 0) return { creditNoteId: null };

  const invoice = await tx.organizationInvoice.findUnique({
    where: { id: payment.billableToOrgInvoiceId },
    select: {
      id: true,
      status: true,
      issuedAt: true,
      subtotalPaise: true,
      totalPaise: true,
      igstPaise: true,
      cgstPaise: true,
      sgstPaise: true,
    },
  });
  const org = await tx.organization.findUnique({
    where: { id: payment.organizationId },
    select: { id: true, slug: true, invoiceNumberPrefix: true },
  });
  if (!invoice || !org) return { creditNoteId: null };

  // #776 / PR#785 review — only credit-note an invoice that was actually issued
  // to the buyer. `rollupOrgInvoiceAccruals({ issueImmediately:false })` stamps
  // Payment.billableToOrgInvoiceId on a DRAFT invoice; minting a CGST Sec 34 credit
  // note against an unissued document is a filing defect. DRAFT accruals are netted
  // down on the leg instead (see the INVOICE_ACCRUAL refund branch above).
  if (invoice.status === "DRAFT" || !invoice.issuedAt) {
    return { creditNoteId: null };
  }

  // #812 — `invoicedReverse` is the TAX-EXCLUSIVE leg amount being reversed (the
  // INVOICE_ACCRUAL legs are the invoice's pre-tax subtotal; invoices are built
  // tax-exclusive: total = subtotal + GST). So the GST rate is the invoice's tax
  // over its SUBTOTAL, not over its total, and the reversed amount is the credit
  // note's subtotal with tax added on top — mirroring the invoice's own
  // structure. Computing the fraction over totalPaise (tax-inclusive) under-
  // credited the full GST (CGST Sec 34 reverses output tax proportionally). The
  // sibling mintInvoiceRefundCreditNote takes a tax-INCLUSIVE payment refund, so
  // it keeps the over-total fraction — do not change it.
  const invoiceTax = invoice.igstPaise + invoice.cgstPaise + invoice.sgstPaise;
  const taxFraction =
    invoice.subtotalPaise > 0 ? invoiceTax / invoice.subtotalPaise : 0;
  const cnSubtotal = invoicedReverse;
  const cnTax = Math.round(invoicedReverse * taxFraction);
  const cnTotal = cnSubtotal + cnTax;
  const interState = invoice.igstPaise > 0;
  const cnIgst = interState ? cnTax : 0;
  const cnSgst = interState ? 0 : Math.floor(cnTax / 2);
  const cnCgst = interState ? 0 : cnTax - cnSgst;

  const { creditNoteNumber, fiscalYear } = await generateOrgCreditNoteNumber(
    tx,
    org,
    new Date(),
  );

  const cn = await tx.creditNote.create({
    data: {
      creditNoteNumber,
      fiscalYear,
      organizationId: org.id,
      invoiceId: invoice.id,
      refundId: params.refundId,
      reason: params.reason,
      subtotalPaise: cnSubtotal,
      igstPaise: cnIgst,
      cgstPaise: cnCgst,
      sgstPaise: cnSgst,
      totalPaise: cnTotal,
      status: "ISSUED",
      issuedAt: new Date(),
      // #738-B — chargeback-minted notes link the dispute for the audit trail.
      disputeId: params.disputeId ?? null,
    },
    select: { id: true },
  });
  return { creditNoteId: cn.id };
}

/**
 * #776 / PR#785 review — mint a GST credit note (CGST Sec 34) for a refunded
 * ORG INVOICE payment (the org paid an OrganizationInvoice via the gateway and
 * that payment was refunded). The booking-centric `mintRefundCreditNote` keys off
 * a Payment's invoice-accrual legs and doesn't cover this path. Idempotent on
 * `refundId` (CreditNote.refundId @unique); only issues against an ISSUED/PAID
 * invoice — never a DRAFT. Must run inside a tx.
 */
export async function mintInvoiceRefundCreditNote(
  tx: Tx,
  params: {
    invoiceId: string;
    refundId: string;
    amountPaise: number;
    reason: string;
  },
): Promise<{ creditNoteId: string | null }> {
  const existing = await tx.creditNote.findUnique({
    where: { refundId: params.refundId },
    select: { id: true },
  });
  if (existing) return { creditNoteId: existing.id };

  const invoice = await tx.organizationInvoice.findUnique({
    where: { id: params.invoiceId },
    select: {
      id: true,
      organizationId: true,
      status: true,
      issuedAt: true,
      totalPaise: true,
      igstPaise: true,
      cgstPaise: true,
      sgstPaise: true,
    },
  });
  if (!invoice || invoice.totalPaise <= 0) return { creditNoteId: null };
  if (invoice.status === "DRAFT" || !invoice.issuedAt) {
    return { creditNoteId: null };
  }

  const org = await tx.organization.findUnique({
    where: { id: invoice.organizationId },
    select: { id: true, slug: true, invoiceNumberPrefix: true },
  });
  if (!org) return { creditNoteId: null };

  const cnTotal = Math.min(params.amountPaise, invoice.totalPaise);
  if (cnTotal <= 0) return { creditNoteId: null };

  // Same proportional-tax shape as mintRefundCreditNote.
  const invoiceTax = invoice.igstPaise + invoice.cgstPaise + invoice.sgstPaise;
  const taxFraction =
    invoice.totalPaise > 0 ? invoiceTax / invoice.totalPaise : 0;
  const cnTax = Math.round(cnTotal * taxFraction);
  const cnSubtotal = cnTotal - cnTax;
  const interState = invoice.igstPaise > 0;
  const cnIgst = interState ? cnTax : 0;
  const cnSgst = interState ? 0 : Math.floor(cnTax / 2);
  const cnCgst = interState ? 0 : cnTax - cnSgst;

  const { creditNoteNumber, fiscalYear } = await generateOrgCreditNoteNumber(
    tx,
    org,
    new Date(),
  );

  const cn = await tx.creditNote.create({
    data: {
      creditNoteNumber,
      fiscalYear,
      organizationId: org.id,
      invoiceId: invoice.id,
      refundId: params.refundId,
      reason: params.reason,
      subtotalPaise: cnSubtotal,
      igstPaise: cnIgst,
      cgstPaise: cnCgst,
      sgstPaise: cnSgst,
      totalPaise: cnTotal,
      status: "ISSUED",
      issuedAt: new Date(),
    },
    select: { id: true },
  });
  return { creditNoteId: cn.id };
}
