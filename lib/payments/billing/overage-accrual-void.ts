/**
 * A reversed CHARGE_ORG overage's child accrual Payment (minted by
 * `mintChildOverageAccrualPayment`) is voided while un-invoiced: a full
 * `OVERAGE_INVOICE_ACCRUAL_REVERSAL` leg nets it to zero in the rollup, and the
 * mirror of its accrual journal returns the receivable, fee and GST. An invoiced
 * child stays on its invoice for the credit-note path.
 */
import type { Tx } from "@/lib/prisma";
import { recordSystemEventSafe } from "@/lib/enterprise/system-events";
import { postJournalMirror } from "./org-invoice-journal";

export const overageAccrualKey = (childPaymentId: string) =>
  `overage-accrual:${childPaymentId}`;
const overageAccrualVoidedKey = (childPaymentId: string) =>
  `overage-accrual-voided:${childPaymentId}`;

/** Void every un-invoiced child accrual behind a utilization's uncollected CHARGE_ORG overages. */
export async function voidReversedOverageAccruals(
  tx: Tx,
  params: { bookingUtilizationId: string; parentPaymentId: string },
): Promise<void> {
  const events = await tx.overageEvent.findMany({
    where: {
      bookingUtilizationId: params.bookingUtilizationId,
      overageBehavior: "CHARGE_ORG",
      chargeStatus: { in: ["PENDING", "ACCRUED"] },
      payment: {
        parentPaymentId: params.parentPaymentId,
        legs: { some: { source: "OVERAGE_INVOICE_ACCRUAL" } },
      },
    },
    select: { paymentId: true },
  });

  const notVoided: string[] = [];
  for (const { paymentId: childId } of events) {
    if (!childId) continue;
    // The rollup stamps billableToOrgInvoiceId on this row, so the CAS and the
    // stamp serialize: whichever commits first wins the child.
    const claim = await tx.payment.updateMany({
      where: {
        id: childId,
        paymentStatus: "SUCCEEDED",
        billableToOrgInvoiceId: null,
        legs: { none: { source: "OVERAGE_INVOICE_ACCRUAL_REVERSAL" } },
      },
      data: { updatedAt: new Date() },
    });
    if (claim.count === 0) {
      notVoided.push(childId);
      continue;
    }
    const accrual = await tx.paymentLeg.findUniqueOrThrow({
      where: {
        paymentId_source: {
          paymentId: childId,
          source: "OVERAGE_INVOICE_ACCRUAL",
        },
      },
      select: { amountPaise: true, sourceRef: true },
    });
    if (accrual.amountPaise > 0) {
      await tx.paymentLeg.create({
        data: {
          paymentId: childId,
          source: "OVERAGE_INVOICE_ACCRUAL_REVERSAL",
          amountPaise: -accrual.amountPaise,
          sourceRef: accrual.sourceRef,
        },
      });
    }
    await postJournalMirror(tx, {
      sourceKey: overageAccrualKey(childId),
      idempotencyKey: overageAccrualVoidedKey(childId),
      paymentId: childId,
      description:
        "CHARGE_ORG overage accrual voided: its booking was reversed",
    });
  }

  if (notVoided.length > 0) {
    await recordSystemEventSafe({
      db: tx,
      category: "PAYMENT",
      severity: "WARN",
      message: `OVERAGE_ACCRUAL_INVOICED: ${notVoided.length} reversed overage accrual(s) of payment ${params.parentPaymentId} are already invoiced and need a credit note`,
      context: {
        parentPaymentId: params.parentPaymentId,
        childPaymentIds: notVoided,
      },
    });
  }
}
