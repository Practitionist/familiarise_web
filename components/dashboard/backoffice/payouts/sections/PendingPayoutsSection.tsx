"use client";

import { payoutMethodLabel } from "@/lib/labels/money-labels";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Check, X } from "lucide-react";

import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { needsTypedConfirm } from "@/lib/ui/typed-confirm";
import { formatCurrencyAmount } from "@/utils/formatting";

import type { Payout } from "@/types/payouts";
import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";

interface PayoutListResponse {
  payouts: Payout[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

// #1771 K-4 — "instant" narrows to above-cap instant payouts awaiting approval.
async function fetchPendingPayouts(
  instantOnly: boolean,
): Promise<PayoutListResponse> {
  const response = await fetch(
    `/api/admin/payouts?status=PENDING&limit=100${instantOnly ? "&kind=INSTANT" : ""}`,
  );
  if (!response.ok) {
    throw new Error("Failed to fetch payouts");
  }
  return response.json() as Promise<PayoutListResponse>;
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
  const response = await fetch(`/api/admin/payouts/${id}`, {
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
  const response = await fetch(`/api/admin/payouts/${id}`, {
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

export default function PendingPayoutsSection() {
  // Staff read payouts, never decide one (#1527 capability context).
  const canManage = useBackofficeCapability().can("payouts.manage");
  const queryClient = useQueryClient();
  const [selectedPayout, setSelectedPayout] = useState<Payout | null>(null);
  const [instantOnly, setInstantOnly] = useState(false);
  const [dialogType, setDialogType] = useState<"approve" | "reject" | null>(
    null,
  );

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-payouts-pending", instantOnly],
    queryFn: () => fetchPendingPayouts(instantOnly),
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

  const columns: ResponsiveColumn<Payout>[] = [
    {
      key: "consultant",
      header: "Consultant",
      primary: true,
      cell: (payout) => (
        <div>
          <p className="text-sm font-medium text-foreground">
            {payout.consultantName}
          </p>
          <p className="text-xs text-muted-foreground">
            {payout.consultantEmail}
          </p>
        </div>
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
            {due.toLocaleDateString()}
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
        <span className="text-sm text-muted-foreground">
          {new Date(payout.createdAt).toLocaleDateString()}
        </span>
      ),
    },
  ];

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
              onClick={() => setInstantOnly((v) => !v)}
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
