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
import { humanizeEnum } from "@/lib/ui/tone";
import { formatCurrencyAmount } from "@/utils/formatting";

// Stateless; module scope keeps the panel's cognitive complexity down.
const columns: ResponsiveColumn<OrgReceivablePosting>[] = [
  {
    key: "posted",
    header: "Posted",
    primary: true,
    className: "text-xs text-muted-foreground",
    cell: (p) => new Date(p.postedAt).toLocaleDateString(),
  },
  {
    key: "movement",
    header: "Movement",
    cell: (p) =>
      p.movement === "ACCRUED" ? (
        <StatusBadge label="Accrued" tone="caution" />
      ) : (
        <StatusBadge label="Cleared" tone="success" />
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
    className: "font-mono text-xs",
    // Ids, not links: ADR 20's addendum gives no org role a per-session page.
    cell: (p) => p.appointmentId ?? p.paymentId ?? p.invoiceId ?? "—",
  },
  {
    key: "status",
    header: "Invoice",
    className: "text-xs",
    // The posting has no status (append-only ledger); what the org can act
    // on is the invoice that would clear it.
    cell: (p) => {
      if (p.invoiceStatus) return humanizeEnum(p.invoiceStatus);
      return p.movement === "ACCRUED" ? "Not yet invoiced" : "—";
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
        title="Couldn't load accrued usage"
        description="Reload the page to try again."
      />
    );
  }
  return (
    <>
      <p className="max-w-3xl text-sm text-muted-foreground">
        Each sponsored booking adds to this balance and each invoice payment
        clears it, so a charge shows here before it appears on an invoice.
        Nothing here can be edited; a correction arrives as a later
        counter-posting.
      </p>
      <StatRow columns={3}>
        <Stat
          label="Owed now"
          value={formatCurrencyAmount(receivables.outstandingPaise, "INR")}
          tone={receivables.outstandingPaise > 0 ? "warning" : "neutral"}
        />
        <Stat
          label="Accrued to date"
          value={formatCurrencyAmount(receivables.accruedPaise, "INR")}
        />
        <Stat
          label="Cleared to date"
          value={formatCurrencyAmount(receivables.clearedPaise, "INR")}
        />
      </StatRow>
      <Section title="Postings">
        <ResponsiveTable<OrgReceivablePosting>
          columns={columns}
          rows={receivables.postings}
          getRowId={(p) => p.entryId}
          empty="Nothing has accrued yet. Only invoice-funded bookings, and any shortfall a wallet debit could not cover, accrue here."
        />
        {receivables.totalPostings > receivables.postings.length && (
          <p className="mt-2 text-xs text-muted-foreground">
            Showing the {receivables.postings.length} most recent of{" "}
            {receivables.totalPostings} postings. The totals above cover all of
            them.
          </p>
        )}
      </Section>
    </>
  );
}
