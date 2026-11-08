/**
 * The platform's void of an ISSUED/OVERDUE org invoice: VOID, a Sec 34 credit
 * note for what the invoice still carries, the PO draw returned, and either a
 * re-bill (REBILL) or a write-off of the receivable (FORGIVE).
 */
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { transitionOrgInvoice } from "@/lib/enterprise/transitions";
import type { Tx } from "@/lib/prisma";
import {
  mintInvoiceRefundCreditNote,
  remainingOrgInvoiceCreditPaise,
} from "@/lib/payments/operations/refund";
import {
  invoiceIssuedKey,
  postInvoiceVoidedJournal,
} from "./org-invoice-journal";
import { lockPayableInvoice } from "./org-invoice-settlement";
import { INVOICE_VOID_MODE_LABEL } from "@/lib/labels/org-labels";
import { formatCurrencyAmount } from "@/utils/formatting";
import { transitionOverage } from "./overage-transitions";

/**
 * REBILL: the void corrects the document, so its bookings return to the next
 * rollup and no revenue is reversed. FORGIVE: the org is let off, so the
 * receivable is written off against GST and fee income; experts keep their share.
 */
export type InvoiceVoidMode = "REBILL" | "FORGIVE";

export interface VoidedOrgInvoice {
  invoiceId: string;
  invoiceNumber: string;
  creditNoteId: string | null;
  rebilledPaymentCount: number;
  receivableWrittenOffPaise: number;
  /** The credit note corrects an IRN-registered invoice; the IRN is not cancelled. */
  irnCorrectedByCreditNote: boolean;
}

export async function voidOrgInvoice(
  tx: Tx,
  args: {
    organizationId: string;
    invoiceId: string;
    mode: InvoiceVoidMode;
    reason: string;
    actorMembershipId: string;
  },
): Promise<VoidedOrgInvoice> {
  const { organizationId, invoiceId, mode } = args;
  const invoice = await tx.organizationInvoice.findFirst({
    where: { id: invoiceId, organizationId },
    select: {
      id: true,
      status: true,
      invoiceNumber: true,
      totalPaise: true,
      subtotalPaise: true,
      irn: true,
      _count: { select: { billedPayments: true } },
    },
  });
  if (!invoice) {
    throw new OpsRefusal(
      "INVOICE_NOT_FOUND",
      "No such invoice for this organisation.",
      404,
    );
  }
  if (invoice.status === "PAID" || invoice.status === "REFUNDED") {
    throw new OpsRefusal(
      "INVOICE_PAID_USE_REFUND",
      "A paid invoice cannot be voided; refund it instead.",
    );
  }
  if (invoice.status !== "ISSUED" && invoice.status !== "OVERDUE") {
    throw new OpsRefusal(
      "INVOICE_NOT_VOIDABLE",
      `Only an issued or overdue invoice can be voided; this one is ${invoice.status}.`,
    );
  }
  // Taken before the receipt count: a bank transfer waits on the same row lock.
  if (!(await lockPayableInvoice(tx, invoiceId))) {
    throw new OpsRefusal(
      "INVOICE_NOT_VOIDABLE",
      "This invoice changed state; reload and try again.",
    );
  }
  const receipts = await tx.organizationInvoiceReceipt.count({
    where: { invoiceId },
  });
  // Received money would be stranded by a void; it goes back through a refund.
  if (receipts > 0) {
    throw new OpsRefusal(
      "INVOICE_PART_PAID_USE_REFUND",
      "This invoice has recorded payments; refund them before voiding it.",
    );
  }
  const billsBookings = invoice._count.billedPayments > 0;
  if (mode === "REBILL" && !billsBookings) {
    throw new OpsRefusal(
      "REBILL_NEEDS_BOOKINGS",
      "Only a rollup invoice that bills bookings can be voided for re-billing.",
    );
  }

  await transitionOrgInvoice(tx, {
    where: { id: invoiceId, organizationId },
    to: "VOID",
    // The next GET …/pdf regenerates so the watermark shows the status.
    data: {
      providerPaymentOrderId: null,
      pdfStoragePath: null,
      pdfGeneratedAt: null,
    },
    audit: {
      organizationId,
      actorMembershipId: args.actorMembershipId,
      category: "INVOICE",
      action: AUDIT_ACTIONS.INVOICE.INVOICE_VOIDED,
      description: `Invoice ${invoice.invoiceNumber} for ${formatCurrencyAmount(Number(invoice.totalPaise), "INR")} voided ${INVOICE_VOID_MODE_LABEL[mode]}`,
      details: { invoiceId, from: invoice.status, to: "VOID", mode },
    },
  });

  // What the invoice still carries once earlier credit notes are netted.
  const receivablePaise = await remainingOrgInvoiceCreditPaise(tx, invoice);
  const minted =
    receivablePaise > 0
      ? await mintInvoiceRefundCreditNote(tx, {
          invoiceId,
          amountPaise: receivablePaise,
          reason: `Invoice ${invoice.invoiceNumber} voided: ${args.reason}`,
          voidedInvoiceId: invoiceId,
        })
      : { creditNoteId: null };

  let rebilledPaymentCount = 0;
  let receivableWrittenOffPaise = 0;
  if (mode === "REBILL") {
    rebilledPaymentCount = (
      await tx.payment.updateMany({
        where: { billableToOrgInvoiceId: invoiceId },
        data: { billableToOrgInvoiceId: null },
      })
    ).count;
    await transitionOverage(
      tx,
      { overageBehavior: "CHARGE_ORG", invoiceLineItem: { invoiceId } },
      "PENDING",
      { invoiceLineItemId: null, settledAt: null },
      { fromIn: ["ACCRUED"] },
    );
  } else if (minted.creditNoteId) {
    // Bookings accrued the receivable; otherwise only an issue journal did.
    const booked =
      billsBookings ||
      (await tx.ledgerTransaction.findUnique({
        where: { idempotencyKey: invoiceIssuedKey(invoiceId) },
        select: { id: true },
      })) !== null;
    if (booked) {
      await postInvoiceVoidedJournal(tx, {
        invoiceId,
        organizationId,
        receivablePaise,
        creditNoteId: minted.creditNoteId,
      });
      receivableWrittenOffPaise = receivablePaise;
    }
  }

  return {
    invoiceId,
    invoiceNumber: invoice.invoiceNumber,
    creditNoteId: minted.creditNoteId,
    rebilledPaymentCount,
    receivableWrittenOffPaise,
    irnCorrectedByCreditNote: invoice.irn !== null,
  };
}
