/**
 * What an INVOICE-funded org currently owes the platform, posting by posting.
 *
 * #1169 residual — the ledger has carried an `ORG_RECEIVABLE` account per org
 * since #771. A sponsored booking debits it, an invoice payment credits it back
 * and a shortfall on a wallet debit accrues into it, so it is the exact record
 * of what the org has consumed but not yet paid for. None of it reached the
 * org's own billing page: that page showed issued invoices and the wallet, and
 * an accrual that had not yet been rolled into an invoice was invisible to the
 * people responsible for paying it.
 *
 * This is a read. The ledger is append-only and reversals are counter-postings
 * (#771 D8), so there is nothing here to write and no status to flip.
 *
 * ADR 20 — metadata only. The postings name their source appointment and
 * payment so an accounts-payable team can tie a line back to a booking; they
 * carry no session content, not even the plan title.
 *
 * Returns a fully plain/JSON-safe object (no Date, no bigint) so it crosses the
 * RSC → client boundary verbatim. Auth stays at the call site.
 */

import type {
  LedgerTransactionKind,
  MemberRole,
  OrgInvoiceStatus,
} from "@prisma/client";

import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { ledgerAccountId } from "@/lib/payments/ledger/post";
import { ORG_CLAWBACK_KEY_FILTER } from "@/lib/payments/payouts/clawback-recovery";
import { sumPaise } from "@/lib/payments/utils/money";
import { canSeeDraftInvoices } from "@/lib/enterprise/invoice-visibility";

/** How many postings the page shows before it says there are more. */
export const ORG_RECEIVABLES_PAGE_SIZE = 50;

export interface OrgReceivablePosting {
  entryId: string;
  /** ISO-8601. */
  postedAt: string;
  amountPaise: number;
  /**
   * Which way the posting moved the balance. A DEBIT to ORG_RECEIVABLE is the
   * org taking on the obligation; a CREDIT is it being discharged.
   */
  movement: "ACCRUED" | "CLEARED";
  kind: LedgerTransactionKind;
  description: string | null;
  paymentId: string | null;
  /** The booking behind the payment, when the posting has one. */
  appointmentId: string | null;
  /**
   * The posting's own invoice, else the invoice its booking was billed on.
   * Id and number are null for a draft the viewer may not see; status stays.
   */
  invoiceId: string | null;
  invoiceNumber: string | null;
  /** Where that invoice stands, when there is one. */
  invoiceStatus: OrgInvoiceStatus | null;
  /** A charge whose payment the billing summary counts as "not yet invoiced". */
  awaitingInvoice: boolean;
}

export interface OrgReceivablesPayload {
  /** True once the org has ever had a receivable account. */
  hasAccount: boolean;
  /** Σ debits — what the org has taken on. */
  accruedPaise: number;
  /** Σ credits — what has been discharged. */
  clearedPaise: number;
  /** The difference: what is still owed. */
  outstandingPaise: number;
  /** Newest first, capped at `ORG_RECEIVABLES_PAGE_SIZE`. */
  postings: OrgReceivablePosting[];
  /** Total postings on the account, so the page can say what it is not showing. */
  totalPostings: number;
}

const EMPTY: OrgReceivablesPayload = {
  hasAccount: false,
  accruedPaise: 0,
  clearedPaise: 0,
  outstandingPaise: 0,
  postings: [],
  totalPostings: 0,
};

export async function getOrgReceivables(
  orgId: string,
  viewerRole: MemberRole,
  limit: number = ORG_RECEIVABLES_PAGE_SIZE,
): Promise<OrgReceivablesPayload> {
  // The account id is deterministic, so no lookup by scope is needed and an
  // org that has never accrued simply has no account.
  const accountId = ledgerAccountId({
    kind: "ORG_RECEIVABLE",
    organizationId: orgId,
  });

  const account = await prisma.ledgerAccount.findUnique({
    where: { id: accountId },
    select: { id: true },
  });
  if (!account) return EMPTY;

  // Totals come from the database rather than the page of rows below: the page
  // is capped, and a total computed over a capped page is a wrong total.
  // One snapshot: a counter-posting committed between separate reads would
  // make the totals and the page disagree.
  // Payout clawbacks share the account but are netted from payouts, never invoiced.
  const where = { accountId, transaction: { NOT: ORG_CLAWBACK_KEY_FILTER } };
  const [byDirection, totalPostings, entries] = await prisma.$transaction(
    [
      prisma.ledgerEntry.groupBy({
        by: ["direction"],
        where,
        _sum: { amountPaise: true },
      }),
      prisma.ledgerEntry.count({ where }),
      prisma.ledgerEntry.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          direction: true,
          amountPaise: true,
          createdAt: true,
          transaction: {
            select: {
              kind: true,
              description: true,
              paymentId: true,
              invoiceId: true,
            },
          },
        },
      }),
    ],
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );

  const accruedPaise = sumPaise(
    byDirection.find((r) => r.direction === "DEBIT")?._sum.amountPaise,
  );
  const clearedPaise = sumPaise(
    byDirection.find((r) => r.direction === "CREDIT")?._sum.amountPaise,
  );

  // `LedgerTransaction` soft-links its origin by id with no relation, so the
  // booking behind a posting and the state of the invoice that would clear it
  // are two follow-up reads keyed on those ids.
  const paymentIds = [
    ...new Set(
      entries
        .map((e) => e.transaction.paymentId)
        .filter((id): id is string => !!id),
    ),
  ];
  const payments = paymentIds.length
    ? await prisma.payment.findMany({
        where: { id: { in: paymentIds } },
        select: {
          id: true,
          appointmentId: true,
          paymentStatus: true,
          billableToOrgInvoiceId: true,
        },
      })
    : [];
  const paymentById = new Map(payments.map((p) => [p.id, p]));

  // A booking's posting never carries an invoice id; the invoice it was billed
  // on is the payment's billableToOrgInvoiceId, the field the summary counts.
  const invoiceIdOf = (entry: (typeof entries)[number]): string | null => {
    if (entry.transaction.invoiceId) return entry.transaction.invoiceId;
    if (entry.direction !== "DEBIT" || !entry.transaction.paymentId) {
      return null;
    }
    return (
      paymentById.get(entry.transaction.paymentId)?.billableToOrgInvoiceId ??
      null
    );
  };
  const invoiceIds = [
    ...new Set(entries.map(invoiceIdOf).filter((id): id is string => !!id)),
  ];
  const invoices = invoiceIds.length
    ? await prisma.organizationInvoice.findMany({
        where: { id: { in: invoiceIds }, organizationId: orgId },
        select: { id: true, status: true, invoiceNumber: true },
      })
    : [];
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));
  const draftsVisible = canSeeDraftInvoices(viewerRole);

  return {
    hasAccount: true,
    accruedPaise,
    clearedPaise,
    outstandingPaise: accruedPaise - clearedPaise,
    totalPostings,
    postings: entries.map((entry): OrgReceivablePosting => {
      const payment = entry.transaction.paymentId
        ? paymentById.get(entry.transaction.paymentId)
        : undefined;
      const invoiceId = invoiceIdOf(entry);
      const invoice = invoiceId ? invoiceById.get(invoiceId) : undefined;
      const hidden = invoice?.status === "DRAFT" && !draftsVisible;
      return {
        entryId: entry.id,
        postedAt: entry.createdAt.toISOString(),
        amountPaise: sumPaise(entry.amountPaise),
        movement: entry.direction === "DEBIT" ? "ACCRUED" : "CLEARED",
        kind: entry.transaction.kind,
        description: entry.transaction.description,
        paymentId: entry.transaction.paymentId,
        appointmentId: payment?.appointmentId ?? null,
        invoiceId: hidden ? null : invoiceId,
        invoiceNumber: hidden ? null : (invoice?.invoiceNumber ?? null),
        invoiceStatus: invoice?.status ?? null,
        // The billing summary's pending-charges predicate, applied to this row.
        awaitingInvoice:
          entry.direction === "DEBIT" &&
          invoiceId === null &&
          payment?.paymentStatus === "SUCCEEDED",
      };
    }),
  };
}
