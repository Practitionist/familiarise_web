/**
 * Issue-time journal for an org invoice whose GST no booking journal posted:
 * `Dr ORG_RECEIVABLE / Cr PLATFORM_FEE / Cr GST_PAYABLE`, reversed exactly on void.
 * An invoice that bills bookings (rollup lines, or manual lines carrying a
 * paymentId) never posts here — those bookings already credited GST_PAYABLE.
 */
import type { Tx } from "@/lib/prisma";
import {
  postLedgerTxn,
  type AccountRef,
  type Posting,
} from "@/lib/payments/ledger/post";
import { sumPaise } from "@/lib/payments/utils/money";

export const invoiceIssuedKey = (invoiceId: string) =>
  `invoice-issued:${invoiceId}`;
export const invoiceVoidedKey = (invoiceId: string) =>
  `invoice-voided:${invoiceId}`;

export type IssueJournalOutcome =
  "POSTED" | "BILLS_BOOKINGS" | "NOTHING_TO_POST";

/** Post `invoice-issued:<id>` in the issuing transaction, unless the invoice bills bookings. */
export async function postInvoiceIssuedJournal(
  tx: Tx,
  invoiceId: string,
): Promise<IssueJournalOutcome> {
  const invoice = await tx.organizationInvoice.findUniqueOrThrow({
    where: { id: invoiceId },
    select: {
      organizationId: true,
      subtotalPaise: true,
      igstPaise: true,
      cgstPaise: true,
      sgstPaise: true,
      totalPaise: true,
      billedPayments: { select: { id: true }, take: 1 },
      lineItems: {
        where: { paymentId: { not: null } },
        select: { id: true },
        take: 1,
      },
    },
  });
  if (invoice.billedPayments.length > 0 || invoice.lineItems.length > 0) {
    return "BILLS_BOOKINGS";
  }
  if (invoice.totalPaise <= 0) return "NOTHING_TO_POST";

  const taxPaise = invoice.igstPaise + invoice.cgstPaise + invoice.sgstPaise;
  const postings: Posting[] = [
    {
      account: {
        kind: "ORG_RECEIVABLE",
        organizationId: invoice.organizationId,
      },
      direction: "DEBIT",
      amountPaise: invoice.totalPaise,
    },
  ];
  if (invoice.subtotalPaise > 0) {
    postings.push({
      account: { kind: "PLATFORM_FEE" },
      direction: "CREDIT",
      amountPaise: invoice.subtotalPaise,
    });
  }
  if (taxPaise > 0) {
    postings.push({
      account: { kind: "GST_PAYABLE" },
      direction: "CREDIT",
      amountPaise: taxPaise,
    });
  }
  await postLedgerTxn(tx, {
    idempotencyKey: invoiceIssuedKey(invoiceId),
    kind: "INVOICE_ISSUED",
    invoiceId,
    description: "Org invoice issued: receivable, fee income and output GST",
    postings,
  });
  return "POSTED";
}

/** Post the exact mirror of `invoice-issued:<id>`; a no-op when the invoice never posted one. */
export async function postInvoiceVoidedJournal(
  tx: Tx,
  invoiceId: string,
): Promise<boolean> {
  const issued = await tx.ledgerTransaction.findUnique({
    where: { idempotencyKey: invoiceIssuedKey(invoiceId) },
    select: {
      entries: {
        select: {
          direction: true,
          amountPaise: true,
          account: {
            select: {
              kind: true,
              organizationId: true,
              consultantProfileId: true,
              currency: true,
            },
          },
        },
      },
    },
  });
  if (!issued) return false;
  await postLedgerTxn(tx, {
    idempotencyKey: invoiceVoidedKey(invoiceId),
    kind: "INVOICE_ISSUED",
    invoiceId,
    description: "Org invoice voided: reverses its issue journal",
    postings: issued.entries.map((e) => ({
      account: e.account satisfies AccountRef,
      direction: e.direction === "DEBIT" ? "CREDIT" : "DEBIT",
      amountPaise: sumPaise(e.amountPaise),
    })),
  });
  return true;
}

/**
 * The debit side of a gateway refund of an org invoice. An issue-journalled
 * invoice reverses fee and GST, with the GST share taken from the credit note
 * (zero on a commercial note past the s.34(2) cutoff, so the platform absorbs it);
 * any other invoice re-opens the receivable its bookings accrued.
 */
export async function invoiceRefundDebits(
  tx: Tx,
  params: {
    invoiceId: string;
    organizationId: string;
    amountPaise: number;
    creditNoteId: string | null;
  },
): Promise<Posting[]> {
  const issued = await tx.ledgerTransaction.findUnique({
    where: { idempotencyKey: invoiceIssuedKey(params.invoiceId) },
    select: { id: true },
  });
  if (!issued) {
    return [
      {
        account: {
          kind: "ORG_RECEIVABLE",
          organizationId: params.organizationId,
        },
        direction: "DEBIT",
        amountPaise: params.amountPaise,
      },
    ];
  }
  const note = params.creditNoteId
    ? await tx.creditNote.findUnique({
        where: { id: params.creditNoteId },
        select: { igstPaise: true, cgstPaise: true, sgstPaise: true },
      })
    : null;
  const gstPaise = Math.min(
    params.amountPaise,
    note ? note.igstPaise + note.cgstPaise + note.sgstPaise : 0,
  );
  const debits: Posting[] = [];
  if (params.amountPaise - gstPaise > 0) {
    debits.push({
      account: { kind: "PLATFORM_FEE" },
      direction: "DEBIT",
      amountPaise: params.amountPaise - gstPaise,
    });
  }
  if (gstPaise > 0) {
    debits.push({
      account: { kind: "GST_PAYABLE" },
      direction: "DEBIT",
      amountPaise: gstPaise,
    });
  }
  return debits;
}
