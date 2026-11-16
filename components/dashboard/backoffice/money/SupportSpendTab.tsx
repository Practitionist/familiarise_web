"use client";

import Link from "next/link";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { z } from "zod";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { TablePagination } from "@/components/dashboard/TablePagination";
import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { AUDIT_TAB, moneyHubHref } from "@/lib/backoffice/money-tabs";
import {
  readListBody,
  targetRefSchema,
} from "@/lib/backoffice/money-list-schemas";
import type {
  SupportSpendOperator,
  SupportSpendPayment,
  SupportSpendReport,
} from "@/lib/backoffice/support-spend-types";
import { OpsLogFiltersSchema, type OpsLogFilters } from "@/schemas/ops-log";
import { OperatorTime } from "@/lib/time/operator-time";
import { formatCurrencyAmount } from "@/utils/formatting";
import { TargetCell } from "./TargetCell";

const inr = (paise: number) => formatCurrencyAmount(paise, "INR");
const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

const count = z.number().int().nonnegative();
const paise = z.number();

/** The route's body; a malformed one takes the error path. */
export const supportSpendReportSchema = z.object({
  operators: z.array(
    z.object({
      userId: z.string(),
      name: z.string(),
      role: z.string(),
      capped: z.boolean(),
      refunds: z.object({
        istDayPaise: paise,
        rolling24hPaise: paise,
        rolling30dPaise: paise,
        count30d: count,
        platformCancel30dPaise: paise,
        platformCancelUnsplit30dPaise: paise,
      }),
      remainingDailyCapPaise: paise.nullable(),
      holds: z.object({
        appliedIstDay: count,
        applied30d: count,
        released30d: count,
        heldPaise30d: paise,
        appliedWithoutAmount30d: count,
      }),
      payments: z.array(
        z.object({
          paymentId: z.string(),
          target: targetRefSchema.nullable(),
          supportCommittedPaise: paise,
          platformCancelPaise: paise,
          remainingPerPaymentPaise: paise.nullable(),
          holdsApplied: count,
        }),
      ),
      audit: z.object({
        supportRefunds: OpsLogFiltersSchema,
        platformCancels: OpsLogFiltersSchema,
        holdsApplied: OpsLogFiltersSchema,
      }),
    }),
  ),
  total: count,
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  windows: z.object({
    istDayStart: z.string(),
    rolling24hStart: z.string(),
    rolling30dStart: z.string(),
  }),
  caps: z.object({ perPaymentPaise: paise, rolling24hPaise: paise }),
  fetchedAt: z.string(),
});

async function fetchReport(page: number): Promise<SupportSpendReport> {
  const res = await fetch(`/api/admin/support-spend?page=${page}`);
  return readListBody(
    res,
    supportSpendReportSchema,
    "Failed to load support spend",
  );
}

function Figure({
  label,
  value,
  hint,
}: Readonly<{ label: string; value: string; hint?: ReactNode }>) {
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
        <div className="min-w-0 space-y-1">
          <TargetCell
            kind="Payment"
            id={p.paymentId}
            target={p.target}
            basePath={basePath}
          />
          <Link
            className="text-xs underline"
            href={`${basePath}/payments/${p.paymentId}`}
          >
            Open payment
          </Link>
        </div>
      ),
    },
    {
      key: "committed",
      header: "Refunded or committed on the payment, every door (counted)",
      cell: (p) => inr(p.supportCommittedPaise),
    },
    {
      key: "platform-cancel",
      header: "Platform cancels by this operator",
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
            hint={
              <>
                Since <OperatorTime value={report.windows.rolling24hStart} />
              </>
            }
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
            hint={`Included in the refund totals, the daily limit and the ${inr(caps.perPaymentPaise)} per-payment limit.${
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
  const [page, setPage] = useState(1);
  const seeded = page === initial.page;
  const { data = initial } = useQuery({
    queryKey: ["money-support-spend", page],
    queryFn: () => fetchReport(page),
    initialData: seeded ? initial : undefined,
    initialDataUpdatedAt: seeded
      ? new Date(initial.fetchedAt).getTime()
      : undefined,
    placeholderData: keepPreviousData,
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
      <TablePagination
        page={page}
        pageSize={data.pageSize}
        total={data.total}
        onPageChange={setPage}
      />
    </div>
  );
}
