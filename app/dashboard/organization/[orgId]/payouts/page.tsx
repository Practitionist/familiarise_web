"use client";

import { use, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Lock,
  Wallet,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertCircle,
} from "lucide-react";

import {
  DashboardHeader,
  DashboardContent,
  DashboardGrid,
} from "@/components/dashboard/DashboardShell";
import { StatCard, StatCardSkeleton } from "@/components/dashboard/StatCard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatCurrencyAmount } from "@/utils/formatting";
import { useOrgRole } from "../useOrgRole";

interface PayoutItem {
  id: string;
  amount: number;
  netPayout: number;
  grossRevenue: number;
  platformFee: number;
  refunds: number;
  currency: string;
  status: string;
  periodStart: string;
  periodEnd: string;
  processedAt: string | null;
  createdAt: string;
}

interface PayoutsResponse {
  payouts?: PayoutItem[];
  error?: string;
  flag?: string;
}

async function fetchPayouts(orgId: string): Promise<PayoutsResponse> {
  const res = await fetch(`/api/organizations/${orgId}/payouts`);
  if (res.status === 501) return res.json();
  if (!res.ok) throw new Error("Failed to load payouts");
  return res.json();
}

const STATUS_CONFIG: Record<
  string,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: typeof Clock }
> = {
  PENDING: { label: "Pending", variant: "secondary", icon: Clock },
  PROCESSING: { label: "Processing", variant: "outline", icon: Loader2 },
  COMPLETED: { label: "Completed", variant: "default", icon: CheckCircle2 },
  FAILED: { label: "Failed", variant: "destructive", icon: XCircle },
  ON_HOLD: { label: "On Hold", variant: "outline", icon: AlertCircle },
};

export default function OrgPayoutsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const { isAtLeast } = useOrgRole(orgId);
  const queryClient = useQueryClient();
  const [createError, setCreateError] = useState<string | null>(null);

  const { data, isPending } = useQuery({
    queryKey: ["org-payouts", orgId],
    queryFn: () => fetchPayouts(orgId),
  });

  const createBatch = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}/payouts`, {
        method: "POST",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create payout batch");
      }
      return res.json();
    },
    onSuccess: () => {
      setCreateError(null);
      queryClient.invalidateQueries({ queryKey: ["org-payouts", orgId] });
    },
    onError: (err: Error) => {
      setCreateError(err.message);
    },
  });

  const isGated = !!data?.flag;
  const payouts = data?.payouts ?? [];

  const totalPaid = payouts
    .filter((p) => p.status === "COMPLETED")
    .reduce((s, p) => s + p.netPayout, 0);
  const pendingAmount = payouts
    .filter((p) => p.status === "PENDING" || p.status === "PROCESSING")
    .reduce((s, p) => s + p.netPayout, 0);

  return (
    <>
      <DashboardHeader
        title="Payouts"
        subtitle="Settlement history for the organization"
      />
      <DashboardContent>
        {isPending ? (
          <DashboardGrid columns={3}>
            {[1, 2, 3].map((i) => (
              <StatCardSkeleton key={i} />
            ))}
          </DashboardGrid>
        ) : isGated ? (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Lock className="h-5 w-5 text-zinc-500" />
                <CardTitle>Provider tier required</CardTitle>
              </div>
              <CardDescription>
                Payouts are available once your organization joins the
                Provider tier. Contact us to enable it.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <>
            {/* Summary cards */}
            <DashboardGrid columns={3}>
              <StatCard
                title="Total paid out"
                value={formatCurrencyAmount(totalPaid, "INR")}
                subtitle={`${payouts.filter((p) => p.status === "COMPLETED").length} payouts`}
                icon={Wallet}
                variant="success"
              />
              <StatCard
                title="Pending"
                value={formatCurrencyAmount(pendingAmount, "INR")}
                icon={Clock}
                variant={pendingAmount > 0 ? "warning" : "default"}
              />
              <StatCard
                title="Total payouts"
                value={payouts.length}
                icon={CheckCircle2}
              />
            </DashboardGrid>

            {/* Create payout button */}
            {isAtLeast("ORG_OWNER") && (
              <div className="mt-4 flex items-center gap-3">
                <Button
                  onClick={() => createBatch.mutate()}
                  disabled={createBatch.isPending}
                  size="sm"
                >
                  {createBatch.isPending && (
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  )}
                  Create Payout Batch
                </Button>
                {createError && (
                  <p className="text-sm text-red-600">{createError}</p>
                )}
              </div>
            )}

            {/* Payout history table */}
            <Card className="mt-6">
              <CardHeader>
                <CardTitle className="text-base">Payout History</CardTitle>
              </CardHeader>
              <CardContent>
                {payouts.length === 0 ? (
                  <p className="text-sm text-zinc-500 text-center py-8">
                    No payouts yet. Earnings will accumulate and you can create a
                    payout batch when ready.
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
                        {payouts.map((payout) => {
                          const cfg = STATUS_CONFIG[payout.status] ?? STATUS_CONFIG.PENDING;
                          return (
                            <tr key={payout.id} className="border-b last:border-0">
                              <td className="py-3 text-zinc-700">
                                {new Date(payout.periodStart).toLocaleDateString()} -{" "}
                                {new Date(payout.periodEnd).toLocaleDateString()}
                              </td>
                              <td className="py-3 text-right text-zinc-500">
                                {formatCurrencyAmount(payout.grossRevenue, payout.currency)}
                              </td>
                              <td className="py-3 text-right font-medium text-zinc-900">
                                {formatCurrencyAmount(payout.netPayout, payout.currency)}
                              </td>
                              <td className="py-3 text-center">
                                <Badge variant={cfg.variant}>{cfg.label}</Badge>
                              </td>
                              <td className="py-3 text-right text-zinc-500">
                                {payout.processedAt
                                  ? new Date(payout.processedAt).toLocaleDateString()
                                  : new Date(payout.createdAt).toLocaleDateString()}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </DashboardContent>
    </>
  );
}
