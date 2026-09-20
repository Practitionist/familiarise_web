"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight, CreditCard } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/dashboard/DataCard";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { cn } from "@/utils/tailwind";
import { formatCurrencyAmount } from "@/utils/formatting";
import { receiptHref } from "@/lib/appointments/payment-display";
import {
  derivePaymentPresentation,
  toneBadge,
  type MoneyState,
  type MoneyStateKind,
} from "@/lib/dashboard/money-state";
import type { ConsulteePaymentRow } from "@/lib/data/consultee-payments";
import { FailedRefundNote } from "./FailedRefundNote";

/**
 * #1675 X5 — the payment history: rows under month headers, each with ONE
 * money line and ONE badge from `derivePaymentPresentation`, so the list and
 * the appointment detail page say the same thing about a payment. A row's
 * doors (refund, dispute, support) live on the detail page it links to
 * (locked 2026-09-13); the list only offers the receipt.
 */

type Chip = "all" | "paid" | "refunded" | "sponsored" | "failed";

const CHIPS: { key: Chip; label: string }[] = [
  { key: "all", label: "All" },
  { key: "paid", label: "Paid" },
  { key: "refunded", label: "Refunded" },
  { key: "sponsored", label: "Sponsored" },
  { key: "failed", label: "Failed" },
];

const CHIP_STATES: Record<Exclude<Chip, "all" | "failed">, MoneyStateKind[]> = {
  paid: ["PAID", "DISPUTED"],
  refunded: ["REFUNDED", "PARTIALLY_REFUNDED", "REFUND_PENDING"],
  sponsored: ["SPONSORED"],
};

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
  chip: Exclude<Chip, "all"> | null;
}

function toRow(payment: ConsulteePaymentRow): Row {
  const { moneyState } = derivePaymentPresentation(
    payment.presentation,
    "CONSULTEE",
  );
  let chip: Row["chip"] = null;
  if (isFailedRow(payment)) chip = "failed";
  else if (CHIP_STATES.paid.includes(moneyState.state)) chip = "paid";
  else if (CHIP_STATES.refunded.includes(moneyState.state)) chip = "refunded";
  else if (CHIP_STATES.sponsored.includes(moneyState.state)) chip = "sponsored";
  return { payment, moneyState, chip };
}

/** The badge: the money state's tone and label, caution for a charge that failed. */
function rowBadge(row: Row) {
  if (row.chip === "failed") {
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
}: {
  payments: ConsulteePaymentRow[];
  consulteeId: string;
}) {
  const [chip, setChip] = useState<Chip>("all");
  const rows = useMemo(() => payments.map(toRow), [payments]);
  const shown = chip === "all" ? rows : rows.filter((r) => r.chip === chip);

  // Newest first, as the read orders them; the month header changes when the
  // month does.
  const groups = useMemo(() => {
    const out: { month: string; rows: Row[] }[] = [];
    for (const row of shown) {
      const month = MONTH.format(new Date(row.payment.createdAt));
      const last = out[out.length - 1];
      if (last && last.month === month) last.rows.push(row);
      else out.push({ month, rows: [row] });
    }
    return out;
  }, [shown]);

  if (payments.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card">
        <EmptyState
          icon={CreditCard}
          title="No payments yet"
          description="Every charge, refund and sponsored booking will show up here."
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter">
        {CHIPS.map((c) => (
          <button
            key={c.key}
            type="button"
            aria-pressed={chip === c.key}
            onClick={() => setChip(c.key)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              chip === c.key
                ? "border-foreground bg-foreground text-background"
                : "border-border bg-card text-muted-foreground hover:text-foreground",
            )}
          >
            {c.label}
          </button>
        ))}
      </div>

      {groups.length === 0 ? (
        <div className="rounded-xl border border-border bg-card">
          <EmptyState title="Nothing under this filter" />
        </div>
      ) : (
        groups.map((group) => (
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
        ))
      )}
    </div>
  );
}

function HistoryRow({ row, consulteeId }: { row: Row; consulteeId: string }) {
  const { payment, moneyState } = row;
  const detailHref = payment.appointmentId
    ? `/dashboard/consultee/${consulteeId}/appointments/${payment.appointmentId}`
    : null;
  // A failed refund's next step: the booking's own support thread when the
  // buyer already opened one (B2C only — org-hosted sessions have no detail
  // page, ADR 20), else the Support hub where they can start it.
  const supportHref =
    payment.hasSupportThread && detailHref && !payment.organizationId
      ? detailHref
      : `/dashboard/consultee/${consulteeId}/support`;
  // The row's own Payment input carries the receipt pointers the shared
  // resolver reads (invoice PDF first, else the gateway receipt).
  const receipt = receiptHref(payment.presentation.payments[0]);
  const type = typeLabel(payment.appointmentType);
  const failedRefunds = payment.refunds.filter((r) => r.status === "FAILED");

  return (
    <li className="flex items-start gap-3 px-4 py-3.5 sm:px-5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {detailHref ? (
            <Link
              href={detailHref}
              className="truncate text-sm font-medium text-foreground hover:underline underline-offset-4"
            >
              {payment.planTitle}
            </Link>
          ) : (
            <span className="truncate text-sm font-medium text-foreground">
              {payment.planTitle}
            </span>
          )}
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
            supportHref={supportHref}
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
      {detailHref && (
        <Link
          href={detailHref}
          aria-label={`Open ${payment.planTitle}`}
          className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className="h-4 w-4" />
        </Link>
      )}
    </li>
  );
}
