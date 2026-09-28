"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ChevronRight, CreditCard } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { formatCurrencyAmount } from "@/utils/formatting";
import { receiptHref } from "@/lib/appointments/payment-display";
import {
  derivePaymentPresentation,
  toneBadge,
  type MoneyState,
} from "@/lib/dashboard/money-state";
import type { ConsulteePaymentRow } from "@/lib/data/consultee-payments";
import { FailedRefundNote } from "./FailedRefundNote";

/**
 * #1675 X5 — the payment history: rows under month headers, each with ONE
 * money line and ONE badge from `derivePaymentPresentation`, so the list and
 * the detail pages say the same thing about a payment. #1527 — each row opens
 * its own payment detail page; filters and paging live in the URL above this
 * list (PaymentsTab), so this renders exactly the page it is given.
 */

/** A charge that never landed: kept visible, never a money state of its own. */
const isFailedRow = (p: ConsulteePaymentRow) =>
  p.status === "FAILED" || p.status === "EXPIRED";

const MONTH = new Intl.DateTimeFormat("en-IN", {
  month: "long",
  year: "numeric",
  timeZone: "Asia/Kolkata",
});
const DAY = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  timeZone: "Asia/Kolkata",
});

const typeLabel = (type: string | null) =>
  type ? type.charAt(0) + type.slice(1).toLowerCase() : null;

interface Row {
  payment: ConsulteePaymentRow;
  moneyState: MoneyState;
}

function toRow(payment: ConsulteePaymentRow): Row {
  const { moneyState } = derivePaymentPresentation(
    payment.presentation,
    "CONSULTEE",
  );
  return { payment, moneyState };
}

/** The badge: the money state's tone and label, caution for a charge that failed. */
function rowBadge(row: Row) {
  if (isFailedRow(row.payment)) {
    return toneBadge(
      "caution",
      row.payment.status === "EXPIRED" ? "Expired" : "Failed",
    );
  }
  return toneBadge(row.moneyState.tone, row.moneyState.label);
}

export function PaymentsHistoryList({
  payments,
  consulteeId,
  emptyTitle = "No payments yet",
}: Readonly<{
  payments: ConsulteePaymentRow[];
  consulteeId: string;
  /** Filters in force change what "empty" means. */
  emptyTitle?: string;
}>) {
  const rows = useMemo(() => payments.map(toRow), [payments]);

  // Newest first, as the read orders them; the month header changes when the
  // month does.
  const groups = useMemo(() => {
    const out: { month: string; rows: Row[] }[] = [];
    for (const row of rows) {
      const month = MONTH.format(new Date(row.payment.createdAt));
      const last = out.at(-1);
      if (last?.month === month) last.rows.push(row);
      else out.push({ month, rows: [row] });
    }
    return out;
  }, [rows]);

  if (payments.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card">
        <EmptyState
          icon={CreditCard}
          title={emptyTitle}
          description="Every charge and refund will show up here."
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <section key={group.month} aria-label={group.month}>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {group.month}
          </h3>
          <ul className="divide-y divide-border rounded-xl border border-border bg-card">
            {group.rows.map((row) => (
              <HistoryRow
                key={row.payment.id}
                row={row}
                consulteeId={consulteeId}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function HistoryRow({
  row,
  consulteeId,
}: Readonly<{ row: Row; consulteeId: string }>) {
  const { payment, moneyState } = row;
  // #1527 — the row opens the charge itself; the booking is one link further.
  const detailHref = `/dashboard/consultee/${consulteeId}/payments/${payment.id}`;
  // The row's own Payment input carries the receipt pointers the shared
  // resolver reads (invoice PDF first, else the gateway receipt).
  const receipt = receiptHref(payment.presentation.payments[0]);
  const type = typeLabel(payment.appointmentType);
  const failedRefunds = payment.refunds.filter((r) => r.status === "FAILED");

  return (
    <li className="flex items-start gap-3 px-4 py-3.5 sm:px-5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link
            href={detailHref}
            className="truncate text-sm font-medium text-foreground hover:underline underline-offset-4"
          >
            {payment.planTitle}
          </Link>
          {type && (
            <Badge className="rounded-md border-0 bg-muted px-1.5 py-0 text-[10px] font-semibold text-muted-foreground">
              {type}
            </Badge>
          )}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          with {payment.consultantName}
        </p>
        <p className="mt-1 text-sm text-foreground">{moneyState.line}</p>
        {moneyState.detail && (
          <p className="text-xs text-muted-foreground">{moneyState.detail}</p>
        )}
        {failedRefunds.map((refund) => (
          <FailedRefundNote
            key={refund.id}
            status={refund.status}
            amountText={formatCurrencyAmount(
              refund.amountPaise,
              payment.currency,
            )}
            supportHref={detailHref}
          />
        ))}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <StatusBadge {...rowBadge(row)} size="sm" />
        <span className="text-xs text-muted-foreground">
          {DAY.format(new Date(payment.createdAt))}
        </span>
        {receipt && (
          <a
            href={receipt}
            className="text-xs font-medium text-foreground underline underline-offset-4 hover:text-muted-foreground"
          >
            View receipt
          </a>
        )}
      </div>
      <Link
        href={detailHref}
        aria-label={`Open the charge for ${payment.planTitle}`}
        className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className="h-4 w-4" />
      </Link>
    </li>
  );
}
