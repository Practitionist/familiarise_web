/**
 * #775 — CHARGE_MEMBER overage side-charge settlement.
 *
 * When a program with `overageBehavior = CHARGE_MEMBER` is booked past its
 * cap, checkout creates a parent-linked PENDING `Payment` (the side-charge,
 * `parentPaymentId` = the booking payment) + an `OverageEvent` (chargeStatus
 * PENDING). The member completes the side-charge via the resume-checkout
 * surface (`POST /api/overage/[overageEventId]/order`, which mints the gateway
 * order and stamps it onto `paymentIntent`); these handlers run on the gateway
 * webhook for that order.
 *
 * Money model (org-relief, DECIDED #775): the org funded the covered portion
 * of the booking and the consultant was paid once at booking; the member's
 * marginal relieves the org. Capture posts `Dr CASH / Cr ORG_PAYABLE(org)`
 * for the FULL marginal (base + surcharge), and that credit is REALIZED AT
 * ORG PAYOUT — it flows to the org through the next payout batch like any
 * other payable. There is NO invoice-netting and NO wallet credit-back for
 * member overage money; the ledger payable is the single realization path.
 * Reconcile asserts every CHARGED member event has its `overage:<sidePaymentId>`
 * txn with Cr ORG_PAYABLE == marginalPaise (OVERAGE_SETTLEMENT_MISMATCH).
 */
import prisma from "@/lib/prisma";
import { PaymentStatus } from "@prisma/client";
import { postLedgerTxn, type Posting } from "@/lib/payments/ledger/post";
import { transitionOverage } from "@/lib/payments/billing/overage-transitions";
import { recordSystemError } from "@/lib/enterprise/system-events";

/**
 * Gateway capture succeeded for a CHARGE_MEMBER side-charge. Idempotent on the
 * side-Payment status + the `overage:<id>` ledger key.
 */
export async function handleOverageMemberSuccess(
  paymentIntentId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const side = await tx.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
      select: {
        id: true,
        amount: true,
        organizationId: true,
        paymentStatus: true,
        parentPaymentId: true,
      },
    });
    if (!side || !side.parentPaymentId) {
      // Not an overage side-charge (or already gone) — nothing to do.
      return;
    }
    if (side.paymentStatus === PaymentStatus.SUCCEEDED) {
      return; // already settled
    }

    await tx.payment.update({
      where: { id: side.id },
      data: { paymentStatus: PaymentStatus.SUCCEEDED },
    });

    // Every Payment must carry ≥1 leg (the funding invariant). The member paid
    // by card; sourceRef is the gateway order id.
    await tx.paymentLeg.upsert({
      where: { paymentId_source: { paymentId: side.id, source: "CARD" } },
      create: {
        paymentId: side.id,
        source: "CARD",
        amountPaise: side.amount,
        sourceRef: paymentIntentId,
      },
      update: {},
    });

    // Transition FIRST so the journal below mirrors the state machine: the
    // org-relief credit posts only for an event that actually became CHARGED.
    const moved = await transitionOverage(
      tx,
      { paymentId: side.id },
      "CHARGED",
      {
        settledAt: new Date(),
      },
    );

    if (moved === 0) {
      // Capture raced a reversal: the booking refunded (event → REVERSED)
      // after the order was minted but before this webhook landed. Money was
      // collected for an obligation that no longer exists — do NOT credit the
      // org; surface it for a manual side-payment refund instead (#782).
      void recordSystemError({
        organizationId: side.organizationId,
        category: "OVERAGE",
        summary: `Overage side-payment ${side.id} captured but its OverageEvent could not move to CHARGED (likely REVERSED mid-flight) — refund the side-payment`,
        err: new Error("OVERAGE_CAPTURED_AFTER_REVERSAL"),
        context: { sidePaymentId: side.id, paymentIntentId },
      }).catch(() => {});
      return;
    }

    if (side.amount > 0 && side.organizationId) {
      const postings: Posting[] = [
        {
          account: { kind: "CASH" },
          direction: "DEBIT",
          amountPaise: side.amount,
        },
        {
          account: { kind: "ORG_PAYABLE", organizationId: side.organizationId },
          direction: "CREDIT",
          amountPaise: side.amount,
        },
      ];
      await postLedgerTxn(tx, {
        idempotencyKey: `overage:${side.id}`,
        kind: "OVERAGE_MEMBER",
        paymentId: side.id,
        postings,
      });
    }
  });
}

/**
 * Gateway capture failed/abandoned for a CHARGE_MEMBER side-charge. Marks the
 * side-Payment FAILED + the OverageEvent FAILED so the dashboard can surface a
 * retry. The booking itself is unaffected (it already happened).
 */
export async function handleOverageMemberFailure(
  paymentIntentId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const side = await tx.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
      select: { id: true, paymentStatus: true, parentPaymentId: true },
    });
    if (!side || !side.parentPaymentId) return;
    if (side.paymentStatus === PaymentStatus.SUCCEEDED) return; // don't undo a success

    await tx.payment.update({
      where: { id: side.id },
      data: { paymentStatus: PaymentStatus.FAILED },
    });
    await transitionOverage(tx, { paymentId: side.id }, "FAILED");
  });
}
