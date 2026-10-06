"use client";

/**
 * C4: reimbursement report for orgs on PERSONAL funding — the Billing
 * "Member spend" tab since #1527 Q7 (renamed from Reimbursements). Per-member
 * totals, a paginated payment list and the /export CSV.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { format } from "date-fns";
import { Download, Loader2, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ScopedListTable,
  type Column,
} from "@/components/dashboard/ScopedListTable";
import { useOrgRole } from "../useOrgRole";

interface ReimbursementRow {
  id: string;
  amount: number;
  currency: string;
  description: string | null;
  createdAt: string;
  user: { id: string; name: string | null; email: string };
  /** Gross, refunded and net in paise — see the route's netting rationale. */
  grossPaise: number;
  refundedPaise: number;
  netReimbursablePaise: number;
}

interface ByMemberRow {
  userId: string;
  membershipId?: string | null;
  name: string | null;
  email: string | null;
  totalPaise: number;
  refundedPaise: number;
  netReimbursablePaise: number;
  paymentCount: number;
  spendLimitPaise?: number | null;
}

interface ReimbursementsResponse {
  items: ReimbursementRow[];
  total: number;
  page: number;
  perPage: number;
  totalPaise: number;
  totalRefundedPaise: number;
  totalNetPaise: number;
  byMember: ByMemberRow[];
}

const COLUMNS: Column<ReimbursementRow>[] = [
  {
    header: "Date",
    accessor: (r) => format(new Date(r.createdAt), "PP"),
  },
  {
    header: "Member",
    accessor: (r) => r.user.name || r.user.email,
  },
  { header: "Description", accessor: (r) => r.description ?? "—" },
  {
    header: "Amount",
    accessor: (r) => `${(r.grossPaise / 100).toFixed(2)} ${r.currency}`,
  },
  {
    header: "Refunded",
    accessor: (r) =>
      r.refundedPaise > 0 ? `−${(r.refundedPaise / 100).toFixed(2)}` : "—",
  },
  {
    // The payable figure. A fully refunded row stays visible at 0.00 rather
    // than vanishing from the report.
    header: "Net reimbursable",
    accessor: (r) =>
      `${(r.netReimbursablePaise / 100).toFixed(2)} ${r.currency}`,
  },
  {
    header: "Payment",
    accessor: (r) => (
      <Badge variant="outline" className="font-mono text-xs">
        {r.id.slice(0, 8)}
      </Badge>
    ),
  },
];

export function MemberSpendPanel({ orgId }: Readonly<{ orgId: string }>) {
  const { can } = useOrgRole(orgId);
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const page = Number(searchParams?.get("page") ?? "1") || 1;
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [editMember, setEditMember] = useState<ByMemberRow | null>(null);
  const [limitRupees, setLimitRupees] = useState("");
  const [limitError, setLimitError] = useState<string | null>(null);

  const canEditLimit = can("billing.manage") || can("programs.manage");

  // ISO-encode the date inputs so the server's z.string().datetime()
  // parser accepts them. Empty inputs are dropped — the API treats
  // missing from/to as "no bound".
  const fromIso = fromDate ? new Date(fromDate).toISOString() : undefined;
  const toIso = toDate
    ? new Date(`${toDate}T23:59:59.999`).toISOString()
    : undefined;

  const apiUrl = new URLSearchParams({ page: String(page) });
  if (fromIso) apiUrl.set("from", fromIso);
  if (toIso) apiUrl.set("to", toIso);

  const exportUrl = (() => {
    const q = new URLSearchParams();
    if (fromIso) q.set("from", fromIso);
    if (toIso) q.set("to", toIso);
    const qs = q.toString();
    return `/api/organizations/${orgId}/reimbursements/export${qs ? `?${qs}` : ""}`;
  })();

  const { data, isLoading, isError, error } = useQuery<ReimbursementsResponse>({
    queryKey: ["org-reimbursements", orgId, page, fromIso, toIso],
    queryFn: async () => {
      const res = await fetch(
        `/api/organizations/${orgId}/reimbursements?${apiUrl.toString()}`,
      );
      if (res.status === 404) {
        throw new Error(
          "Member spend applies only when members pay for sessions themselves.",
        );
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const spendLimitMutation = useMutation({
    mutationFn: async (args: {
      memberKey: string;
      spendLimitPaise: number | null;
    }) => {
      const res = await fetch(
        `/api/organizations/${orgId}/members/${args.memberKey}/spend-limit`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ spendLimitPaise: args.spendLimitPaise }),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (body as { error?: string }).error || "Failed to update spend limit",
        );
      }
      return body;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["org-reimbursements", orgId],
      });
      setEditMember(null);
      setLimitRupees("");
      setLimitError(null);
    },
    onError: (err: Error) => {
      setLimitError(err.message);
    },
  });

  const openEditLimit = (member: ByMemberRow) => {
    setEditMember(member);
    setLimitRupees(
      member.spendLimitPaise != null
        ? (member.spendLimitPaise / 100).toFixed(2)
        : "",
    );
    setLimitError(null);
  };

  const submitSpendLimit = () => {
    if (!editMember) return;
    setLimitError(null);
    const trimmed = limitRupees.trim();
    let spendLimitPaise: number | null = null;
    if (trimmed !== "") {
      const numeric = Number(trimmed.replace(/,/g, ""));
      if (!Number.isFinite(numeric) || numeric < 0) {
        setLimitError("Enter a non-negative amount in rupees, or leave blank.");
        return;
      }
      spendLimitPaise = Math.round(numeric * 100);
    }
    spendLimitMutation.mutate({
      memberKey: editMember.membershipId || editMember.userId,
      spendLimitPaise,
    });
  };

  // The card is labelled "Total to reimburse", so it shows the NET. It used to
  // read the gross, which over-stated the payroll transfer by every refund.
  const totalNetRupees = ((data?.totalNetPaise ?? 0) / 100).toFixed(2);
  const totalRefundedRupees = ((data?.totalRefundedPaise ?? 0) / 100).toFixed(
    2,
  );

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Members paid out of pocket for sessions under this organization. Pay
          them back through your payroll using this report.
        </p>
        <Button asChild variant="outline" size="sm">
          <a href={exportUrl} download>
            <Download className="mr-2 h-4 w-4" />
            Download CSV
          </a>
        </Button>
      </div>
      <div className="grid max-w-md grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="from-date">From</Label>
          <Input
            id="from-date"
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            max={toDate || undefined}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="to-date">To</Label>
          <Input
            id="to-date"
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            min={fromDate || undefined}
          />
        </div>
      </div>

      {data && (
        <div className="flex flex-wrap gap-3">
          <div className="rounded-lg border bg-card p-4">
            <p className="text-xs uppercase text-muted-foreground">
              Total to reimburse
            </p>
            <p className="mt-1 text-2xl font-semibold">₹{totalNetRupees}</p>
            {(data.totalRefundedPaise ?? 0) > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                Net of ₹{totalRefundedRupees} refunded
              </p>
            )}
          </div>
          <div className="rounded-lg border bg-card p-4">
            <p className="text-xs uppercase text-muted-foreground">
              Members owed
            </p>
            <p className="mt-1 text-2xl font-semibold">
              {data.byMember.filter((m) => m.netReimbursablePaise > 0).length}
            </p>
          </div>
          <div className="rounded-lg border bg-card p-4">
            <p className="text-xs uppercase text-muted-foreground">Payments</p>
            <p className="mt-1 text-2xl font-semibold">{data.total}</p>
          </div>
        </div>
      )}

      {data && data.byMember.length > 0 && (
        <div className="rounded-lg border bg-card p-4 space-y-3">
          <p className="text-sm font-medium">Per-member spend &amp; limits</p>
          <div className="divide-y">
            {data.byMember.map((m) => (
              <div
                key={m.userId}
                className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm"
              >
                <div>
                  <p className="font-medium">{m.name || m.email || m.userId}</p>
                  <p className="text-xs text-muted-foreground">
                    {m.paymentCount} payment{m.paymentCount === 1 ? "" : "s"} ·
                    Net reimbursable ₹
                    {(m.netReimbursablePaise / 100).toFixed(2)}
                    {m.spendLimitPaise != null &&
                      ` · Spend limit ₹${(m.spendLimitPaise / 100).toFixed(2)}`}
                  </p>
                </div>
                {canEditLimit && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => openEditLimit(m)}
                  >
                    <Pencil className="mr-1.5 h-3.5 w-3.5" />
                    Edit spend limit
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <ScopedListTable
        title="Reimbursable payments"
        isLoading={isLoading}
        isError={isError}
        errorMessage={
          error instanceof Error ? error.message : "Failed to load."
        }
        items={data?.items ?? []}
        total={data?.total ?? 0}
        page={data?.page ?? page}
        perPage={data?.perPage ?? 20}
        columns={COLUMNS}
        rowKey={(r) => r.id}
        emptyMessage="No reimbursable payments yet — members on this org haven't paid out of pocket for any sessions."
      />

      <Dialog
        open={editMember !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditMember(null);
            setLimitError(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Member Spend Limit</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Set the reimbursement / credit-pool spend ceiling for{" "}
              <strong>
                {editMember?.name || editMember?.email || "this member"}
              </strong>
              .
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="member-spend-limit-rupees">
                Spend limit (INR ₹)
              </Label>
              <Input
                id="member-spend-limit-rupees"
                type="text"
                inputMode="decimal"
                placeholder="Leave blank for no individual limit"
                value={limitRupees}
                onChange={(e) => setLimitRupees(e.target.value)}
              />
            </div>
            {limitError && <p className="text-xs text-red-600">{limitError}</p>}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditMember(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={submitSpendLimit}
              disabled={spendLimitMutation.isPending}
            >
              {spendLimitMutation.isPending ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save spend limit"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
