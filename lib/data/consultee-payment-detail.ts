/**
 * #1527 Q5 — one charge, as its payer reads it: amount and rail, the refund
 * timeline with arrival times, the receipt, the tax invoice and any credit
 * notes, and the booking it paid for.
 *
 * Payer check: the row must belong to the user who owns this consultee
 * profile (and be a top-level charge, not a co-pay line). Anything else reads
 * as "not found" — never "not yours", which would confirm the id exists. The
 * page binds the profile to the session first (requirePersonalProfileAccess).
 */

import prisma from "@/lib/prisma";
import {
  deriveBookingPresentation,
  type MoneyState,
} from "@/lib/dashboard/money-state";
import { receiptHref } from "@/lib/appointments/payment-display";
import { toPlain } from "@/lib/data/serialize";
import {
  paymentRowSelect,
  toRow,
  type ConsulteePaymentRow,
} from "@/lib/data/consultee-payments";

export interface PaymentTimelineStep {
  at: Date | null;
  label: string;
  tone: "success" | "info" | "critical";
}

export interface ConsulteePaymentDetail {
  row: ConsulteePaymentRow;
  moneyState: MoneyState;
  /** Sponsored money shows no amount unless the member paid a co-pay (locked 2026-09-13). */
  showAmount: boolean;
  refundTimeline: PaymentTimelineStep[];
  receiptHref: string | null;
  invoicePdfHref: string | null;
  creditNotes: { id: string; number: string; issuedAt: Date; href: string }[];
  /** What each funding rail carried, in the payer's words. */
  legs: { source: string; amountPaise: number }[];
  coPays: { id: string; amountPaise: number; currency: string }[];
}

const TIMELINE_TONE = {
  "refund-completed": "success",
  "refund-failed": "critical",
  "refund-processing": "info",
  "refund-requested": "info",
} as const;

export async function readConsulteePaymentDetail(args: {
  paymentId: string;
  consulteeId: string;
  /** The profile owner's user id — the payer the row must belong to. */
  userId: string;
}): Promise<ConsulteePaymentDetail | null> {
  const { paymentId, consulteeId, userId } = args;
  const payment = await prisma.payment.findFirst({
    where: {
      id: paymentId,
      userId,
      user: { consulteeProfileId: consulteeId },
      parentPaymentId: null,
      deletedAt: null,
    },
    select: paymentRowSelect(userId),
  });
  if (!payment) return null;

  const [refunds, creditNotes] = await Promise.all([
    // The gateway id only decides "requested" vs "processing"; it never
    // leaves this function.
    prisma.refund.findMany({
      where: { paymentId, deletedAt: null },
      select: {
        amountPaise: true,
        status: true,
        refundId: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    payment.consumerInvoice
      ? prisma.consumerCreditNote.findMany({
          where: { consumerInvoiceId: payment.consumerInvoice.id },
          select: { id: true, creditNoteNumber: true, issuedAt: true },
          orderBy: { issuedAt: "asc" },
        })
      : Promise.resolve([]),
  ]);

  const row = toRow(payment);
  const presentation = deriveBookingPresentation(
    { ...row.presentation, refunds, occurrences: [] },
    "CONSULTEE",
  );
  const coPays = payment.childPayments.map((c) => ({
    id: c.id,
    amountPaise: Number(c.amount),
    currency: c.currency,
  }));

  return toPlain({
    row,
    moneyState: presentation.moneyState,
    showAmount:
      presentation.moneyState.state !== "SPONSORED" || coPays.length > 0,
    refundTimeline: presentation.timeline
      .filter((step) => step.kind)
      .map((step) => ({
        at: step.at,
        label: step.label,
        tone: TIMELINE_TONE[step.kind!],
      })),
    // The tax invoice IS the receipt when one was issued (#1365).
    receiptHref: payment.consumerInvoice
      ? null
      : receiptHref(row.presentation.payments[0]),
    invoicePdfHref: payment.consumerInvoice
      ? `/api/payments/${payment.id}/invoice/pdf`
      : null,
    creditNotes: creditNotes.map((note) => ({
      id: note.id,
      number: note.creditNoteNumber,
      issuedAt: note.issuedAt,
      href: `/api/payments/${payment.id}/credit-note/${note.id}/pdf`,
    })),
    legs: (payment.legs ?? []).map((leg) => ({
      source: leg.source,
      amountPaise: Number(leg.amountPaise),
    })),
    coPays,
  });
}
