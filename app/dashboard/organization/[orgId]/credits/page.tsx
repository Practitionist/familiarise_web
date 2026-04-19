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

// ---------------------------------------------------------------------------
// Types — match GET /api/organizations/[orgId]/billing-account/wallet
// ---------------------------------------------------------------------------

interface WalletResponse {
  billingAccount: {
    id: string;
    currency: string;
    walletBalance: number;
  };
  ledger: Array<{
    id: string;
    deltaPaise: number;
    reason: string;
    balanceAfter: number;
    notes: string | null;
    createdAt: string;
  }>;
  meta: { total: number; page: number; perPage: number };
}

interface WalletErrorResponse {
  error: string;
  currentFundingSource?: string;
}

interface InitiateTopUpResponse {
  providerOrderId: string;
  amountPaise: number;
  status: string;
  reused: boolean;
}

async function fetchWallet(
  orgId: string,
): Promise<WalletResponse | WalletErrorResponse> {
  const res = await fetch(
    `/api/organizations/${orgId}/billing-account/wallet`,
  );
  const body = (await res.json()) as WalletResponse | WalletErrorResponse;
  if (!res.ok) {
    // 404 + 409 carry an `error` + optional `currentFundingSource` — hand
    // them back to the component so it can render a "not on WALLET" card
    // instead of throwing.
    return body;
  }
  return body;
}

async function initiateTopUp(
  orgId: string,
  amountPaise: number,
): Promise<InitiateTopUpResponse> {
  const res = await fetch(
    `/api/organizations/${orgId}/billing-account/wallet/top-ups`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountPaise }),
    },
  );
  const body = await res.json();
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? "Failed to start top-up");
  }
  return body as InitiateTopUpResponse;
}

function isWalletResponse(
  r: WalletResponse | WalletErrorResponse,
): r is WalletResponse {
  return "billingAccount" in r;
}

export default function OrgCreditsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["org-wallet", orgId],
    queryFn: () => fetchWallet(orgId),
  });

  const [showBuy, setShowBuy] = useState(false);
  const [amountMajor, setAmountMajor] = useState("1000");

  const topUpMutation = useMutation({
    mutationFn: () =>
      initiateTopUp(
        orgId,
        Math.round(parseFloat(amountMajor || "0") * 100),
      ),
    onSuccess: (result) => {
      // The API stubs Razorpay order creation (returns a providerOrderId
      // without a live Razorpay `key` yet). When the real gateway step
      // lands the client will open Razorpay checkout here; for now we
      // just close the dialog + refresh so the pending WalletEntry shows
      // up in the ledger.
      setShowBuy(false);
      queryClient.invalidateQueries({ queryKey: ["org-wallet", orgId] });
      console.log(
        `[wallet] top-up initiated: ${result.providerOrderId} (${result.amountPaise} paise)`,
      );
    },
  });

  const walletResponse = data && isWalletResponse(data) ? data : null;
  const walletError = data && !isWalletResponse(data) ? data : null;

  return (
    <>
      <DashboardHeader
        title="Wallet"
        subtitle="Pre-funded credit pool used by WALLET-funded organizations."
        actions={
          walletResponse && (
            <Button size="sm" onClick={() => setShowBuy(true)}>
              <Plus className="h-4 w-4 mr-1" /> Top up
            </Button>
          )
        }
      />
      <DashboardContent>
        {walletError ? (
          <Card>
            <CardHeader>
              <CardTitle>Wallet unavailable</CardTitle>
              <CardDescription>
                {walletError.error}
                {walletError.currentFundingSource && (
                  <>
                    {" "}Current funding source:{" "}
                    <code>{walletError.currentFundingSource}</code>. Wallets
                    only apply to <code>WALLET</code>-funded organizations.
                  </>
                )}
              </CardDescription>
            </CardHeader>
          </Card>
        ) : isLoading || !walletResponse ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : (
          <>
            <DashboardGrid columns={2}>
              <StatCard
                title="Current balance"
                value={formatCurrencyAmount(
                  walletResponse.billingAccount.walletBalance,
                  walletResponse.billingAccount.currency,
                )}
                icon={Coins}
                variant="success"
              />
              <StatCard
                title="Ledger entries"
                value={walletResponse.meta.total.toLocaleString()}
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
                    {walletResponse.ledger.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="text-xs text-zinc-500">
                          {new Date(row.createdAt).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-sm">
                          {row.reason}
                          {row.notes && (
                            <span className="text-xs text-zinc-400 block">
                              {row.notes}
                            </span>
                          )}
                        </TableCell>
                        <TableCell
                          className={`text-right font-mono ${
                            row.deltaPaise >= 0
                              ? "text-emerald-600"
                              : "text-red-600"
                          }`}
                        >
                          {row.deltaPaise >= 0 ? "+" : ""}
                          {formatCurrencyAmount(
                            row.deltaPaise,
                            walletResponse.billingAccount.currency,
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {formatCurrencyAmount(
                            row.balanceAfter,
                            walletResponse.billingAccount.currency,
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                    {walletResponse.ledger.length === 0 && (
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
            <DialogTitle>Top up wallet</DialogTitle>
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
                Minimum ₹100. You&apos;ll be redirected to Razorpay to
                complete the payment when the gateway integration ships.
              </p>
            </div>
            {topUpMutation.isError && (
              <p className="text-sm text-red-600">
                {(topUpMutation.error as Error).message}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBuy(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => topUpMutation.mutate()}
              disabled={topUpMutation.isPending}
            >
              {topUpMutation.isPending ? "Initiating…" : "Continue"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
