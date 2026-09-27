"use client";

import { useState } from "react";
import {
  keepPreviousData,
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { Loader2, PauseCircle } from "lucide-react";

import { Stat, StatRow, StatSkeleton } from "@/components/dashboard/Stat";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatCurrencyAmount } from "@/utils/formatting";
import { humanizeEnum, type Tone } from "@/lib/ui/tone";

interface PayoutItem {
  id: string;
  amountPaise: number;
  netPayoutPaise: number;
  grossRevenuePaise: number;
  platformFeePaise: number;
  refundsPaise: number;
  tdsAmountPaise: number | null;
  currency: string;
  status: string;
  periodStart: string;
  periodEnd: string;
  processedAt: string | null;
  createdAt: string;
}

interface PayoutsResponse {
  data: PayoutItem[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
  // #997 secondary findings — server-aggregated, org-wide (ignores the
  // status filter/page) so the summary cards don't shift as the table is
  // narrowed/paged.
  stats: {
    totalPaidPaise: number;
    pendingPaise: number;
    counts: Record<string, number>;
  };
}

const PAGE_SIZE = 25;

async function fetchPayouts(
  orgId: string,
  offset: number,
  status: StatusFilter,
): Promise<PayoutsResponse> {
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (status !== "ALL") params.set("status", status);
  const res = await fetch(`/api/organizations/${orgId}/payouts?${params}`);
  if (!res.ok) throw new Error("Failed to load payouts");
  return res.json();
}

// POST /payouts expects `{ periodStart, periodEnd }`. The dashboard
// "Create batch" button rolls up everything earned in the last 30 days
// since that matches the default cron cadence; admins running catch-up
// payouts can adjust via the API directly.
function defaultPayoutWindow(): { periodStart: Date; periodEnd: Date } {
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd);
  periodStart.setDate(periodStart.getDate() - 30);
  return { periodStart, periodEnd };
}

// #1762-9 — what each state means on the ORG rail, which never enters
// APPROVED: a batch is created PENDING, the weekly payout run claims it
// (PROCESSING) and the gateway settles it (COMPLETED / FAILED).
const STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: "Queued for the next run", tone: "caution" },
  PROCESSING: { label: "Sending", tone: "info" },
  COMPLETED: { label: "Paid", tone: "success" },
  FAILED: { label: "Failed", tone: "critical" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

// Filter options for the status dropdown (#777 §B). "ALL" is "no filter".
const STATUS_FILTERS = [
  "ALL",
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const filterLabel = (s: StatusFilter) =>
  s === "ALL" ? "All statuses" : STATUS[s].label;

/**
 * Payouts › Runs: the org's settlement batches. Creating a batch is Q10's
 * typed confirm (the org slug) — it had no confirmation at all before #1527.
 */
export function PayoutRunsPanel({
  orgId,
  orgSlug,
  canManage,
  livePayoutsEnabled,
}: Readonly<{
  orgId: string;
  orgSlug: string;
  /** #1132 — payout batches are `payouts.manage` (OWNER + BILLING_ADMIN). */
  canManage: boolean;
  livePayoutsEnabled: boolean;
}>) {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [page, setPage] = useState(1);

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ["org-payouts", orgId, page, statusFilter],
    // Filter/page live in the key, so each value is its own query. Without
    // this, switching to one not yet fetched dropped `data` to undefined and
    // re-showed the loading branch. Same fix as #346 on the appointments list.
    placeholderData: keepPreviousData,
    queryFn: () => fetchPayouts(orgId, (page - 1) * PAGE_SIZE, statusFilter),
  });

  const createBatch = useMutation({
    mutationFn: async () => {
      const { periodStart, periodEnd } = defaultPayoutWindow();
      const res = await fetch(`/api/organizations/${orgId}/payouts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          periodStart: periodStart.toISOString(),
          periodEnd: periodEnd.toISOString(),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        // Thrown message is shown inside the ConfirmDialog.
        throw new Error(err.error || "Couldn't create the payout batch.");
      }
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["org-payouts", orgId] });
    },
  });

  const payouts = data?.data ?? [];
  const pagination = data?.pagination;
  const totalPages = pagination
    ? Math.max(1, Math.ceil(pagination.total / PAGE_SIZE))
    : 1;

  // #997 secondary findings — server-aggregated org-wide totals. "Total paid
  // out" counts only COMPLETED payouts; "In flight" rolls up the rest.
  const stats = data?.stats;
  const totalPaid = stats?.totalPaidPaise ?? 0;
  const pendingAmount = stats?.pendingPaise ?? 0;
  const completedCount = stats?.counts.COMPLETED ?? 0;
  const totalPayoutsCount = stats?.counts.total ?? 0;
  const hasProcessingPayouts = (stats?.counts.PROCESSING ?? 0) > 0;

  // The list itself is now server-paginated + server-filtered (`status`
  // query param), so `payouts` is already the page to render — no more
  // client-side re-filtering over an unbounded fetch (#777 §B superseded).
  const visiblePayouts = payouts;

  if (isPending) {
    return (
      <StatRow columns={3}>
        <StatSkeleton />
        <StatSkeleton />
        <StatSkeleton />
      </StatRow>
    );
  }
  if (isError) {
    // A fetch error must not read as an empty settlement ledger.
    return (
      <ErrorState
        title="Couldn't load payouts"
        description="This is a loading problem, not a zero balance."
        onRetry={() => void refetch()}
      />
    );
  }

  return (
    <>
      <StatRow columns={3}>
        <Stat
          label="Total paid out"
          value={formatCurrencyAmount(totalPaid, "INR")}
          hint={`${completedCount} payouts`}
          tone="success"
        />
        <Stat
          label="In flight"
          value={formatCurrencyAmount(pendingAmount, "INR")}
          tone={pendingAmount > 0 ? "caution" : "neutral"}
        />
        <Stat label="Total payouts" value={totalPayoutsCount} />
      </StatRow>

      {/* #776 §B: disbursement is gated until live payouts go-live;
                say so honestly rather than letting PROCESSING rows imply
                money is moving. */}
      {!livePayoutsEnabled && hasProcessingPayouts && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Bank transfers from the platform aren&apos;t switched on yet.
            Payouts in a run are calculated and held for you, not failed, and
            are sent as soon as transfers go live.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {/* Wave-4 (#1230) — CSV export for bank reconciliation. Plain
                  anchor: the endpoint streams a download and auth rides the
                  session cookie. */}
        <Button asChild size="sm" variant="outline">
          <a href={`/api/organizations/${orgId}/payouts/export`}>Export CSV</a>
        </Button>
        {canManage && (
          <ConfirmDialog
            title="Create a payout batch?"
            description="This rolls every settled earning from the last 30 days into one batch for the next payout run. It can't be undone from here."
            confirmLabel="Create batch"
            requireTyped={orgSlug}
            onConfirm={async () => {
              await createBatch.mutateAsync();
            }}
            trigger={
              <Button size="sm" disabled={createBatch.isPending}>
                {createBatch.isPending && (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                )}
                Create payout batch
              </Button>
            }
          />
        )}
      </div>

      {/* Payout history table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle className="text-base">Payout History</CardTitle>
          {totalPayoutsCount > 0 && (
            <Select
              value={statusFilter}
              onValueChange={(v) => {
                setStatusFilter(v as StatusFilter);
                setPage(1);
              }}
            >
              <SelectTrigger
                className="h-8 w-[200px]"
                aria-label="Filter by status"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_FILTERS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {filterLabel(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </CardHeader>
        <CardContent>
          {totalPayoutsCount === 0 ? (
            <p className="text-sm text-zinc-500 text-center py-8">
              No payouts yet. Earnings accumulate, and a batch collects them for
              the next payout run.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-zinc-500">
                    <th className="text-left py-2 font-medium">Period</th>
                    <th className="text-right py-2 font-medium">Gross</th>
                    <th className="text-right py-2 font-medium">Net</th>
                    <th className="text-center py-2 font-medium">Status</th>
                    <th className="text-right py-2 font-medium">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {visiblePayouts.map((payout) => {
                    const cfg = STATUS[payout.status] ?? {
                      label: humanizeEnum(payout.status),
                      tone: "neutral" as const,
                    };
                    // #776 §B: while live payouts are off, a PROCESSING
                    // row is held at the platform, not in flight — label
                    // it as such so we never imply money is moving.
                    const heldForEnablement =
                      payout.status === "PROCESSING" && !livePayoutsEnabled;
                    // #1132 follow-up — the Net column shows the cash
                    // actually disbursed (amountPaise = net after TDS),
                    // not netPayoutPaise (pre-TDS org share). The
                    // tooltip itemizes every deduction the row carries;
                    // the rest is captioned, never faked.
                    const deduction =
                      payout.grossRevenuePaise - payout.amountPaise;
                    return (
                      <tr key={payout.id} className="border-b last:border-0">
                        <td className="py-3 text-zinc-700">
                          {new Date(payout.periodStart).toLocaleDateString()} -{" "}
                          {new Date(payout.periodEnd).toLocaleDateString()}
                        </td>
                        <td className="py-3 text-right text-zinc-500">
                          {formatCurrencyAmount(
                            payout.grossRevenuePaise,
                            payout.currency,
                          )}
                        </td>
                        <td className="py-3 text-right font-medium text-zinc-900">
                          {deduction > 0 ? (
                            <TooltipProvider delayDuration={200}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="cursor-help underline decoration-dotted underline-offset-2">
                                    {formatCurrencyAmount(
                                      payout.amountPaise,
                                      payout.currency,
                                    )}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent
                                  side="left"
                                  className="max-w-xs text-xs"
                                >
                                  <div className="space-y-0.5">
                                    <div className="flex justify-between gap-4">
                                      <span>Platform fee</span>
                                      <span>
                                        −
                                        {formatCurrencyAmount(
                                          payout.platformFeePaise,
                                          payout.currency,
                                        )}
                                      </span>
                                    </div>
                                    {payout.refundsPaise > 0 && (
                                      <div className="flex justify-between gap-4">
                                        <span>Refunds</span>
                                        <span>
                                          −
                                          {formatCurrencyAmount(
                                            payout.refundsPaise,
                                            payout.currency,
                                          )}
                                        </span>
                                      </div>
                                    )}
                                    {(payout.tdsAmountPaise ?? 0) > 0 && (
                                      <div className="flex justify-between gap-4">
                                        <span>TDS withheld</span>
                                        <span>
                                          −
                                          {formatCurrencyAmount(
                                            payout.tdsAmountPaise ?? 0,
                                            payout.currency,
                                          )}
                                        </span>
                                      </div>
                                    )}
                                    <div className="pt-1 text-[11px]">
                                      Disbursed cash — net of platform fee,
                                      refunds and TDS.
                                    </div>
                                  </div>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          ) : (
                            formatCurrencyAmount(
                              payout.amountPaise,
                              payout.currency,
                            )
                          )}
                        </td>
                        <td className="py-3 text-center">
                          {heldForEnablement ? (
                            <div className="flex flex-col items-center gap-0.5">
                              <StatusBadge label="Held" tone="caution" />
                              <span className="text-[11px] text-muted-foreground">
                                Transfers not live yet
                              </span>
                            </div>
                          ) : (
                            <StatusBadge {...cfg} />
                          )}
                        </td>
                        <td className="py-3 text-right text-zinc-500">
                          {payout.processedAt
                            ? new Date(payout.processedAt).toLocaleDateString()
                            : new Date(payout.createdAt).toLocaleDateString()}
                        </td>
                      </tr>
                    );
                  })}
                  {visiblePayouts.length === 0 && (
                    <tr>
                      <td
                        colSpan={5}
                        className="py-8 text-center text-sm text-zinc-500"
                      >
                        No payouts match this filter.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pagination — the list is now server-paginated (#997 secondary
                findings), so paging is a real fetch, not a client slice. */}
      {totalPages > 1 && (
        <div className="flex justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </Button>
          <span className="flex items-center px-4 text-sm text-zinc-500">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </>
  );
}
