"use client";

import { payoutMethodLabel } from "@/lib/labels/money-labels";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Check, X } from "lucide-react";

import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { keepPreviousPageOnly } from "@/components/dashboard/shared/paged-list-filters";
import { TablePagination } from "@/components/dashboard/TablePagination";
import { PersonCell } from "@/components/dashboard/backoffice/PersonCell";
import {
  payoutListPageSchema,
  readListBody,
  type PayoutListItem,
} from "@/lib/backoffice/money-list-schemas";
import { OperatorTime } from "@/lib/time/operator-time";
import { needsTypedConfirm } from "@/lib/ui/typed-confirm";
import { formatCurrencyAmount } from "@/utils/formatting";

import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { fetchWithReauth } from "@/lib/auth/reauth-client";

type Payout = PayoutListItem;

const PAGE_SIZE = 20;

/** One page of payouts awaiting approval; "instant" narrows to above-cap instant ones. */
async function fetchPendingPayouts(instantOnly: boolean, page: number) {
  const params = new URLSearchParams({
    status: "PENDING",
    limit: String(PAGE_SIZE),
    offset: String((page - 1) * PAGE_SIZE),
  });
  if (instantOnly) params.set("kind", "INSTANT");
  const response = await fetch(`/api/admin/payouts?${params}`);
  return readListBody(
    response,
    payoutListPageSchema,
    "Failed to fetch payouts",
  );
}

type PayoutActionResult = { success: boolean; message: string };

/**
 * The route answers with `{ success, message }`, not a Payout. These were typed
 * `Promise<Payout>` and cast to match, which no caller noticed only because
 * both mutations discard the value — the first `onSuccess: (data) => ...` to
 * read `data.amount` would have got undefined from a type promising a number.
 */
async function approvePayout(
  id: string,
  reason: string,
): Promise<PayoutActionResult> {
  const response = await fetchWithReauth(`/api/admin/payouts/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "approve", reason }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to approve payout");
  }
  return response.json() as Promise<PayoutActionResult>;
}

async function rejectPayout(
  id: string,
  reason: string,
): Promise<PayoutActionResult> {
  const response = await fetchWithReauth(`/api/admin/payouts/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "reject", reason }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to reject payout");
  }
  return response.json() as Promise<PayoutActionResult>;
}

const columns: ResponsiveColumn<Payout>[] = [
  {
    key: "consultant",
    header: "Expert",
    primary: true,
    cell: (payout) => (
      <PersonCell
        person={{
          id: payout.consultantUserId,
          name: payout.consultantName,
          email: payout.consultantEmail,
        }}
      />
    ),
  },
  {
    key: "payoutId",
    header: "Payout ID",
    cell: (payout) => (
      <span
        data-copyable=""
        className="font-mono text-xs text-muted-foreground"
        title={payout.id}
      >
        {payout.id.slice(-8).toUpperCase()}
      </span>
    ),
  },
  {
    key: "amount",
    header: "Amount",
    cell: (payout) => (
      <span className="text-sm font-semibold text-foreground">
        {formatCurrencyAmount(payout.amount, payout.currency)}
      </span>
    ),
  },
  {
    key: "method",
    header: "Method",
    cell: (payout) => (
      <span className="text-sm text-muted-foreground">
        {payoutMethodLabel(payout.method)}
      </span>
    ),
  },
  {
    key: "earnings",
    header: "Earnings",
    cell: (payout) => (
      <span className="text-sm text-muted-foreground">
        {payout.earningsCount} earnings
      </span>
    ),
  },
  {
    key: "dueBy",
    header: "Due by (MSME)",
    cell: (payout) => {
      if (!payout.mustPayByDate) {
        return <span className="text-sm text-muted-foreground">—</span>;
      }
      const due = new Date(payout.mustPayByDate);
      const daysLeft = Math.ceil((due.getTime() - Date.now()) / 86_400_000);
      // <5 days (or overdue) is the §43B(h) alert window — flag it red.
      const urgent = daysLeft < 5;
      return (
        <span
          className={
            urgent
              ? "text-sm font-semibold text-destructive"
              : "text-sm text-muted-foreground"
          }
        >
          <OperatorTime value={due} kind="date" />
          {urgent && (
            <span className="ml-1">
              ({daysLeft < 0 ? "overdue" : `${daysLeft}d`})
            </span>
          )}
        </span>
      );
    },
  },
  {
    key: "date",
    header: "Date",
    cell: (payout) => (
      <OperatorTime
        value={payout.createdAt}
        kind="date"
        className="text-sm text-muted-foreground"
      />
    ),
  },
];

export default function PendingPayoutsSection() {
  // Staff read payouts, never decide one (#1527 capability context).
  const canManage = useBackofficeCapability().can("payouts.manage");
  const queryClient = useQueryClient();
  const [selectedPayout, setSelectedPayout] = useState<Payout | null>(null);
  const [instantOnly, setInstantOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [dialogType, setDialogType] = useState<"approve" | "reject" | null>(
    null,
  );

  const queryKey = ["admin-payouts-pending", instantOnly, page];
  // A filter change never leaves the other filter's rows, and their Approve buttons, on screen.
  const { data, isLoading, error, refetch } = useQuery({
    queryKey,
    queryFn: () => fetchPendingPayouts(instantOnly, page),
    placeholderData: keepPreviousPageOnly(queryKey, 2),
    staleTime: 30 * 1000,
  });

  const approveMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      approvePayout(id, reason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-payouts-pending"] });
      queryClient.invalidateQueries({ queryKey: ["admin-payout-stats"] });
      setDialogType(null);
      setSelectedPayout(null);
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      rejectPayout(id, reason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-payouts-pending"] });
      queryClient.invalidateQueries({ queryKey: ["admin-payout-stats"] });
      setDialogType(null);
      setSelectedPayout(null);
    },
  });

  const handleApprove = (payout: Payout) => {
    setSelectedPayout(payout);
    setDialogType("approve");
  };

  const handleReject = (payout: Payout) => {
    setSelectedPayout(payout);
    setDialogType("reject");
  };

  const renderRowActions = (payout: Payout) => (
    <div className="flex gap-2">
      <Button size="sm" variant="outline" onClick={() => handleApprove(payout)}>
        <Check className="w-4 h-4 mr-1" />
        Approve
      </Button>
      <Button size="sm" variant="outline" onClick={() => handleReject(payout)}>
        <X className="w-4 h-4 mr-1" />
        Reject
      </Button>
    </div>
  );

  if (error && !data) {
    return (
      <ErrorState
        title="Pending payouts could not be loaded"
        onRetry={() => void refetch()}
      />
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-lg">
              Awaiting approval ({data?.pagination.total ?? 0})
            </CardTitle>
            <Button
              size="sm"
              variant={instantOnly ? "default" : "outline"}
              aria-pressed={instantOnly}
              onClick={() => {
                setInstantOnly((v) => !v);
                setPage(1);
              }}
            >
              Instant, waiting for approval
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading || !data ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : (
            <div className="space-y-4">
              <ResponsiveTable<Payout>
                columns={columns}
                rows={data.payouts}
                getRowId={(p) => p.id}
                rowActions={canManage ? renderRowActions : undefined}
                empty={
                  <div className="text-center py-12">
                    <p className="text-muted-foreground">No pending payouts</p>
                  </div>
                }
              />
              <TablePagination
                page={page}
                pageSize={PAGE_SIZE}
                total={data.pagination.total}
                onPageChange={setPage}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* #1771 K-4 — both decisions carry a reason into the audit log;
          #1527 Q10 — an approval at or above the threshold is typed. */}
      {selectedPayout && dialogType && (
        <ConfirmDialog
          key={`${dialogType}-${selectedPayout.id}`}
          open
          onOpenChange={(open) => {
            if (!open) {
              setDialogType(null);
              setSelectedPayout(null);
            }
          }}
          title={dialogType === "approve" ? "Approve payout" : "Reject payout"}
          description={`${formatCurrencyAmount(selectedPayout.amount, selectedPayout.currency)} to ${selectedPayout.consultantName}.`}
          confirmLabel={dialogType === "approve" ? "Approve" : "Reject"}
          tone={dialogType === "reject" ? "destructive" : "default"}
          requireReason={{
            label:
              dialogType === "approve"
                ? "Reason for approving"
                : "Reason for rejecting",
          }}
          requireTyped={
            dialogType === "approve" && needsTypedConfirm(selectedPayout.amount)
              ? "APPROVE"
              : undefined
          }
          onConfirm={async ({ reason }) => {
            const mutation =
              dialogType === "approve" ? approveMutation : rejectMutation;
            await mutation.mutateAsync({
              id: selectedPayout.id,
              reason: reason ?? "",
            });
          }}
        />
      )}
    </>
  );
}
