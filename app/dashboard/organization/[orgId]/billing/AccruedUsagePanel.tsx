"use client";

import { Stat, StatRow } from "@/components/dashboard/Stat";
import { Section } from "@/components/dashboard/Section";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { ErrorState } from "@/components/dashboard/ErrorState";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import type {
  OrgReceivablePosting,
  OrgReceivablesPayload,
} from "@/lib/data/org-receivables";
import { ORG_INVOICE_STATUS_LABEL } from "@/lib/labels/org-labels";
import { formatCurrencyAmount } from "@/utils/formatting";

// Stateless; module scope keeps the panel's cognitive complexity down.
const columns: ResponsiveColumn<OrgReceivablePosting>[] = [
  {
    key: "posted",
    header: "Date",
    primary: true,
    className: "text-xs text-muted-foreground",
    cell: (p) => new Date(p.postedAt).toLocaleDateString(),
  },
  {
    key: "movement",
    header: "Type",
    cell: (p) =>
      p.movement === "ACCRUED" ? (
        <StatusBadge label="Charged" tone="caution" />
      ) : (
        <StatusBadge label="Paid" tone="success" />
      ),
  },
  {
    key: "amount",
    header: "Amount",
    className: "tabular-nums",
    cell: (p) => formatCurrencyAmount(p.amountPaise, "INR"),
  },
  {
    key: "source",
    header: "Source",
    className: "text-xs",
    // No org role has a per-session page, so the row names the kind of source, never its id.
    cell: (p) => {
      if (p.appointmentId) return "Session booking";
      if (p.paymentId) return "Payment";
      if (p.invoiceId) return "Invoice";
      return "—";
    },
  },
  {
    key: "status",
    header: "Invoice",
    className: "text-xs",
    // The posting has no status (append-only ledger); what the org can act
    // on is the invoice that bills it, read from the same field as the summary.
    cell: (p) => {
      if (p.invoiceStatus) {
        const label = ORG_INVOICE_STATUS_LABEL[p.invoiceStatus];
        return p.invoiceNumber ? `${p.invoiceNumber} · ${label}` : label;
      }
      return p.awaitingInvoice ? "Not yet invoiced" : "—";
    },
  },
];

/**
 * Billing › Accrued usage (was "Receivables", #1527): what this organization
 * has used and not yet paid for, posting by posting. From the org's side it is
 * a payable; the ledger calls it ORG_RECEIVABLE (lib/data/org-receivables.ts).
 */
export function AccruedUsagePanel({
  receivables,
}: Readonly<{ receivables: OrgReceivablesPayload | null }>) {
  if (!receivables) {
    return (
      <ErrorState
        title="Couldn't load usage charges"
        description="Reload the page to try again."
      />
    );
  }
  return (
    <>
      <p className="max-w-3xl text-sm text-muted-foreground">
        Each sponsored booking adds to this balance and each invoice payment
        brings it down, so a charge shows here before it appears on an invoice.
        The unpaid balance counts every charge not yet paid, on an invoice or
        not; Outstanding above counts only issued invoices that are due. Nothing
        here can be edited; a correction shows up as a new entry later.
      </p>
      <StatRow columns={3}>
        <Stat
          label="Unpaid balance"
          value={formatCurrencyAmount(receivables.outstandingPaise, "INR")}
          tone={receivables.outstandingPaise > 0 ? "warning" : "neutral"}
        />
        <Stat
          label="Charged so far"
          value={formatCurrencyAmount(receivables.accruedPaise, "INR")}
        />
        <Stat
          label="Paid so far"
          value={formatCurrencyAmount(receivables.clearedPaise, "INR")}
        />
      </StatRow>
      <Section title="Activity">
        <ResponsiveTable<OrgReceivablePosting>
          columns={columns}
          rows={receivables.postings}
          getRowId={(p) => p.entryId}
          empty="Nothing has been charged yet. Only bookings billed on invoice, and any amount your wallet could not cover, show up here."
        />
        {receivables.totalPostings > receivables.postings.length && (
          <p className="mt-2 text-xs text-muted-foreground">
            Showing the {receivables.postings.length} most recent of{" "}
            {receivables.totalPostings} entries. The totals above cover all of
            them.
          </p>
        )}
      </Section>
    </>
  );
}
