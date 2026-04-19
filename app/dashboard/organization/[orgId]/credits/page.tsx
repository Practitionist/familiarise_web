"use client";

import { use, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Coins, Plus } from "lucide-react";
import { z } from "zod";

import { useRequireOrgAccess } from "../useOrgRole";
import { useToast } from "@/hooks/use-toast";
import { loadScript } from "@/app/checkout/plans/utils";
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
// Zod schemas — narrow API responses at the network boundary so the rest
// of the component can rely on inferred types instead of `as`/`unknown`
// casts. Mirrors the pattern in `app/checkout/plans/utils.ts`
// (`checkoutResponseSchema`).
// ---------------------------------------------------------------------------

const walletResponseSchema = z.object({
  billingAccount: z.object({
    id: z.string(),
    currency: z.string(),
    walletBalance: z.number(),
  }),
  ledger: z.array(
    z.object({
      id: z.string(),
      deltaPaise: z.number(),
      reason: z.string(),
      balanceAfter: z.number(),
      notes: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  meta: z.object({
    total: z.number(),
    page: z.number(),
    perPage: z.number(),
  }),
});
type WalletResponse = z.infer<typeof walletResponseSchema>;

const walletErrorResponseSchema = z.object({
  error: z.string(),
  currentFundingSource: z.string().optional(),
});

const walletFetchResultSchema = z.union([
  walletResponseSchema,
  walletErrorResponseSchema,
]);
type WalletFetchResult = z.infer<typeof walletFetchResultSchema>;

const topUpInitiateResponseSchema = z.object({
  topUpId: z.string().min(1),
  razorpayOrderId: z.string().startsWith("order_"),
  keyId: z.string().min(1),
  amountPaise: z.number().int().positive(),
  currency: z.string().length(3),
  status: z.literal("pending"),
  reused: z.boolean(),
});
type TopUpInitiateResponse = z.infer<typeof topUpInitiateResponseSchema>;

const apiErrorSchema = z.object({
  error: z.string().optional(),
  errorType: z.string().optional(),
});

async function fetchWallet(orgId: string): Promise<WalletFetchResult> {
  const res = await fetch(
    `/api/organizations/${orgId}/billing-account/wallet`,
  );
  // 404 + 409 carry an `error` + optional `currentFundingSource` — hand
  // them back to the component so it can render a "not on WALLET" card
  // instead of throwing.
  return walletFetchResultSchema.parse(await res.json());
}

async function initiateTopUp(
  orgId: string,
  amountPaise: number,
): Promise<TopUpInitiateResponse> {
  const res = await fetch(
    `/api/organizations/${orgId}/billing-account/wallet/top-ups`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountPaise }),
    },
  );
  const raw = await res.json();
  if (!res.ok) {
    const parsedError = apiErrorSchema.safeParse(raw);
    throw new Error(
      parsedError.success
        ? (parsedError.data.error ?? "Failed to start top-up")
        : "Failed to start top-up",
    );
  }
  return topUpInitiateResponseSchema.parse(raw);
}

function isWalletResponse(r: WalletFetchResult): r is WalletResponse {
  return "billingAccount" in r;
}

export default function OrgCreditsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const { allowed } = useRequireOrgAccess(orgId, {
    minRole: "MANAGER",
    canSponsor: true,
    fundingSource: "WALLET",
  });
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["org-wallet", orgId],
    queryFn: () => fetchWallet(orgId),
    enabled: allowed,
  });

  const [showBuy, setShowBuy] = useState(false);
  const [amountMajor, setAmountMajor] = useState("1000");
  const { toast } = useToast();

  const topUpMutation = useMutation({
    mutationFn: async () => {
      const amountPaise = Math.round(parseFloat(amountMajor || "0") * 100);
      const result = await initiateTopUp(orgId, amountPaise);

      const loaded = await loadScript(
        "https://checkout.razorpay.com/v1/checkout.js",
      ).catch(() => false);
      if (!loaded || !window.Razorpay) {
        throw new Error(
          "Razorpay checkout failed to load. Please disable ad-blockers and retry.",
        );
      }
      await new Promise<void>((resolve) => {
        const rzp = new window.Razorpay({
          key: result.keyId,
          amount: result.amountPaise,
          currency: result.currency,
          name: "Familiarise",
          description: "Wallet top-up",
          order_id: result.razorpayOrderId,
          handler: () => {
            // Webhook is the source of truth for crediting the wallet
            // (idempotent on `WalletEntry.providerOrderId`). The popup
            // handler just signals "checkout finished" so we can
            // refresh the ledger; the actual balance update arrives
            // when Razorpay POSTs to /api/webhooks/razorpay.
            resolve();
          },
          theme: { color: "#2563EB" },
        });
        rzp.on("payment.failed", () => {
          // Surface the error and resolve so React Query records
          // the success of the *order* call but the user sees the
          // payment failure via toast.
          toast({
            title: "Payment failed",
            description:
              "Your card was declined or the payment timed out. Please try again.",
            variant: "destructive",
          });
          resolve();
        });
        rzp.open();
      });
      return result;
    },
    onSuccess: () => {
      setShowBuy(false);
      queryClient.invalidateQueries({ queryKey: ["org-wallet", orgId] });
    },
  });

  const walletResponse = data && isWalletResponse(data) ? data : null;
  const walletError = data && !isWalletResponse(data) ? data : null;

  if (!allowed) return null;

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
                Minimum ₹100. Razorpay checkout will open in a popup;
                your wallet credit is added once payment is captured.
              </p>
            </div>
            {topUpMutation.isError && (
              <p className="text-sm text-red-600">
                {topUpMutation.error instanceof Error
                  ? topUpMutation.error.message
                  : "Failed to start top-up"}
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
