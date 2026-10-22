"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { AUDIT_TAB, moneyHubHref } from "@/lib/backoffice/money-tabs";
import type {
  SupportSpendOperator,
  SupportSpendPayment,
  SupportSpendReport,
} from "@/lib/backoffice/support-spend-types";
import type { OpsLogFilters } from "@/schemas/ops-log";
import { formatCurrencyAmount } from "@/utils/formatting";

const inr = (paise: number) => formatCurrencyAmount(paise, "INR");
const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

async function fetchReport(): Promise<SupportSpendReport> {
  const res = await fetch("/api/admin/support-spend");
  if (!res.ok) throw new Error("Failed to load support spend");
  return res.json() as Promise<SupportSpendReport>;
}

function Figure({
  label,
  value,
  hint,
}: Readonly<{ label: string; value: string; hint?: string }>) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function paymentColumns(
  basePath: string,
  caps: SupportSpendReport["caps"],
): ResponsiveColumn<SupportSpendPayment>[] {
  return [
    {
      key: "payment",
      header: "Payment",
      primary: true,
      cell: (p) => (
        <Link
          className="underline"
          href={`${basePath}/payments/${p.paymentId}`}
        >
          {p.paymentId}
        </Link>
      ),
    },
    {
      key: "committed",
      header: "Support refunds, all operators (counted)",
      cell: (p) => inr(p.supportCommittedPaise),
    },
    {
      key: "platform-cancel",
      header: `Platform cancels by this operator (not counted toward the ${inr(caps.perPaymentPaise)} limit)`,
      cell: (p) => inr(p.platformCancelPaise),
    },
    {
      key: "remaining",
      header: `Left of the ${inr(caps.perPaymentPaise)} per-payment limit`,
      cell: (p) =>
        p.remainingPerPaymentPaise === null
          ? "No staff limit"
          : inr(p.remainingPerPaymentPaise),
    },
    { key: "holds", header: "Holds applied", cell: (p) => p.holdsApplied },
  ];
}

function OperatorCard({
  operator,
  report,
  basePath,
}: Readonly<{
  operator: SupportSpendOperator;
  report: SupportSpendReport;
  basePath: string;
}>) {
  const { refunds, holds } = operator;
  const { caps } = report;
  const audit = (filters: OpsLogFilters) =>
    moneyHubHref(basePath, AUDIT_TAB.key, filters);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {operator.name}
          <Badge variant="outline">{operator.role}</Badge>
          {operator.capped ? null : (
            <Badge variant="secondary">No staff limits</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Figure
            label="Refunds today (IST calendar day)"
            value={inr(refunds.istDayPaise)}
            hint="Since 00:00 IST. For reference; the limit uses the last 24 hours."
          />
          <Figure
            label="Refunds, last 24 hours (limit basis)"
            value={inr(refunds.rolling24hPaise)}
            hint={`Since ${new Date(report.windows.rolling24hStart).toLocaleString()}`}
          />
          <Figure
            label="Daily limit left (last 24 hours)"
            value={
              operator.remainingDailyCapPaise === null
                ? "No staff limit"
                : inr(operator.remainingDailyCapPaise)
            }
            hint={`${inr(caps.rolling24hPaise)} per rolling 24 hours, as the refund doors enforce it.`}
          />
          <Figure
            label="Refunds, last 30 days"
            value={inr(refunds.rolling30dPaise)}
            hint={plural(refunds.count30d, "refund")}
          />
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Figure
            label="Holds applied today (IST)"
            value={String(holds.appliedIstDay)}
          />
          <Figure
            label="Holds, last 30 days"
            value={`${holds.applied30d} applied, ${holds.released30d} released`}
          />
          <Figure
            label="Held, last 30 days"
            value={inr(holds.heldPaise30d)}
            hint={
              holds.appliedWithoutAmount30d > 0
                ? `${plural(holds.appliedWithoutAmount30d, "older hold")} recorded without an amount (count only).`
                : undefined
            }
          />
          <Figure
            label="Platform-cancel refunds, last 30 days"
            value={inr(refunds.platformCancel30dPaise)}
            hint={`Included in the refund totals and the daily limit; not counted toward the ${inr(caps.perPaymentPaise)} per-payment limit.${
              refunds.platformCancelUnsplit30dPaise > 0
                ? ` ${inr(refunds.platformCancelUnsplit30dPaise)} from older group cancels has no per-payment split.`
                : ""
            }`}
          />
        </div>
        <ResponsiveTable<SupportSpendPayment>
          columns={paymentColumns(basePath, caps)}
          rows={operator.payments}
          getRowId={(p) => p.paymentId}
          empty={
            <p className="py-4 text-center text-sm text-muted-foreground">
              No refunds or holds in the last 30 days.
            </p>
          }
        />
        <p className="flex flex-wrap gap-4 text-sm">
          <Link
            className="underline"
            href={audit(operator.audit.supportRefunds)}
          >
            Support refunds in the audit log
          </Link>
          <Link
            className="underline"
            href={audit(operator.audit.platformCancels)}
          >
            Platform cancels in the audit log
          </Link>
          <Link className="underline" href={audit(operator.audit.holdsApplied)}>
            Holds in the audit log
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

/** Per-operator refunds and holds against the staff limits, seeded by the server render. */
export function SupportSpendTab({
  initial,
}: Readonly<{ initial: SupportSpendReport }>) {
  const { basePath, role } = useBackofficeCapability();
  const { data } = useQuery({
    queryKey: ["money-support-spend"],
    queryFn: fetchReport,
    initialData: initial,
    initialDataUpdatedAt: new Date(initial.fetchedAt).getTime(),
    staleTime: 30_000,
  });
  return (
    <div className="space-y-6">
      <PageHeader
        title="Support spend"
        description={
          role === "ADMIN"
            ? "Refunds and holds by every operator against the staff limits."
            : "Your refunds and holds against the staff limits."
        }
      />
      {data.operators.length === 0 ? (
        <p className="text-sm text-muted-foreground">No operators to show.</p>
      ) : (
        data.operators.map((operator) => (
          <OperatorCard
            key={operator.userId}
            operator={operator}
            report={data}
            basePath={basePath}
          />
        ))
      )}
    </div>
  );
}
