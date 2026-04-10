"use client";

import { use, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Coins, Plus } from "lucide-react";

import {
  DashboardHeader,
  DashboardContent,
  DashboardGrid,
} from "@/components/dashboard/DashboardShell";
import { StatCard } from "@/components/dashboard/StatCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatCurrencyAmount } from "@/utils/formatting";

interface CreditsResponse {
  billingMode: string;
  pool: {
    balance: number;
    totalPurchased: number;
    currency: string;
  } | null;
  ledger: Array<{
    id: string;
    delta: number;
    reason: string;
    balanceAfter: number;
    createdAt: string;
  }>;
}

async function fetchCredits(orgId: string): Promise<CreditsResponse> {
  const res = await fetch(`/api/organizations/${orgId}/credits`);
  if (!res.ok) throw new Error("Failed to load credits");
  return res.json();
}

async function purchaseCredits(orgId: string, amountPaise: number) {
  const res = await fetch(`/api/organizations/${orgId}/credits/purchase`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amountPaise }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "Failed to purchase credits");
  return body;
}

export default function OrgCreditsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["org-credits", orgId],
    queryFn: () => fetchCredits(orgId),
  });

  const [showBuy, setShowBuy] = useState(false);
  const [amountMajor, setAmountMajor] = useState("1000");

  const purchaseMutation = useMutation({
    mutationFn: () =>
      purchaseCredits(orgId, Math.round(parseFloat(amountMajor || "0") * 100)),
    onSuccess: (result: { pendingPhaseJ?: boolean; message?: string }) => {
      if (result.pendingPhaseJ) {
        alert(result.message ?? "Gateway integration coming soon.");
      }
      setShowBuy(false);
      queryClient.invalidateQueries({ queryKey: ["org-credits", orgId] });
    },
  });

  const wrongMode = data && data.billingMode !== "SEAT_PACK";

  return (
    <>
      <DashboardHeader
        title="Credits"
        subtitle="Pre-purchased credit pool used by SEAT_PACK billing"
        actions={
          !wrongMode && (
            <Button size="sm" disabled title="Gateway integration coming soon">
              <Plus className="h-4 w-4 mr-1" /> Buy credits (coming soon)
            </Button>
          )
        }
      />
      <DashboardContent>
        {wrongMode ? (
          <Card>
            <CardHeader>
              <CardTitle>Not on Seat Pack billing</CardTitle>
              <CardDescription>
                This page is only relevant for organizations using SEAT_PACK
                billing mode. Billing mode is set during organization
                creation and cannot be changed after the first payment.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : isLoading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : (
          <>
            <DashboardGrid columns={2}>
              <StatCard
                title="Current balance"
                value={formatCurrencyAmount(
                  data?.pool?.balance ?? 0,
                  data?.pool?.currency ?? "INR",
                )}
                icon={Coins}
                variant="success"
              />
              <StatCard
                title="Lifetime purchased"
                value={formatCurrencyAmount(
                  data?.pool?.totalPurchased ?? 0,
                  data?.pool?.currency ?? "INR",
                )}
                icon={Coins}
              />
            </DashboardGrid>

            <Card className="mt-6">
              <CardHeader>
                <CardTitle className="text-base">Recent activity</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead className="text-right">Δ</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data?.ledger.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="text-xs text-zinc-500">
                          {new Date(row.createdAt).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-sm">{row.reason}</TableCell>
                        <TableCell
                          className={`text-right font-mono ${
                            row.delta >= 0 ? "text-emerald-600" : "text-red-600"
                          }`}
                        >
                          {row.delta >= 0 ? "+" : ""}
                          {formatCurrencyAmount(row.delta, "INR")}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {formatCurrencyAmount(row.balanceAfter, "INR")}
                        </TableCell>
                      </TableRow>
                    ))}
                    {data && data.ledger.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={4}
                          className="text-center text-sm text-zinc-500 py-6"
                        >
                          No activity yet.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </>
        )}
      </DashboardContent>

      <Dialog open={showBuy} onOpenChange={setShowBuy}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Buy credits</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="credit-amount">Amount (₹)</Label>
              <Input
                id="credit-amount"
                type="number"
                min="100"
                step="100"
                value={amountMajor}
                onChange={(e) => setAmountMajor(e.target.value)}
              />
              <p className="text-xs text-zinc-500">
                You will be redirected to the payment gateway to complete the
                purchase.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBuy(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => purchaseMutation.mutate()}
              disabled={purchaseMutation.isPending}
            >
              {purchaseMutation.isPending ? "Initiating…" : "Continue"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
