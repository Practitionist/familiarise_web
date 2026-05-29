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
 * Money model (org-relief): the booking already charged the org the full
 * price and paid the consultant once. The member's marginal therefore RELIEVES
 * the org — it posts `Dr CASH / Cr ORG_PAYABLE(org)`, a credit the org realises
 * in settlement. (How buyer orgs net that credit against their wallet/invoice
 * is a tracked refinement in #775; the journal stays balanced regardless.)
 */
import prisma from "@/lib/prisma";
import { PaymentStatus } from "@prisma/client";
import { postLedgerTxn, type Posting } from "@/lib/payments/ledger/post";

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

    if (side.amount > 0 && side.organizationId) {
      const postings: Posting[] = [
        { account: { kind: "CASH" }, direction: "DEBIT", amountPaise: side.amount },
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

    await tx.overageEvent.updateMany({
      where: { paymentId: side.id },
      data: { chargeStatus: "CHARGED", settledAt: new Date() },
    });
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
    await tx.overageEvent.updateMany({
      where: { paymentId: side.id },
      data: { chargeStatus: "FAILED" },
    });
  });
}
