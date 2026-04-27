"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Coins, Plus } from "lucide-react";
import { z } from "zod";

import { useOrgRole } from "../useOrgRole";
import { useToast } from "@/hooks/use-toast";
import { loadScript } from "@/app/checkout/plans/utils";
import { useSession } from "@/lib/auth-client";
import { normalizeRazorpayContact } from "@/lib/payments/razorpay-prefill";
import { DashboardGrid } from "@/components/dashboard/DashboardShell";
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

const topUpStatusResponseSchema = z.object({
  topUp: z.object({
    topUpId: z.string(),
    providerPaymentId: z.string().nullable(),
    status: z.enum(["pending", "confirmed"]),
    amountPaise: z.number(),
    balanceAfter: z.number(),
    createdAt: z.string(),
  }),
});
type TopUpStatus = z.infer<typeof topUpStatusResponseSchema>["topUp"];

const apiErrorSchema = z.object({
  error: z.string().optional(),
  errorType: z.string().optional(),
});

const TOPUP_POLL_INTERVAL_MS = 1000;
const TOPUP_POLL_MAX_ATTEMPTS = 20;

type TopUpMutationResult =
  | { result: TopUpInitiateResponse; outcome: "confirmed"; confirmed: TopUpStatus }
  | { result: TopUpInitiateResponse; outcome: "pending"; confirmed: null }
  | { result: TopUpInitiateResponse; outcome: "not_paid"; confirmed: null };

async function fetchWallet(orgId: string): Promise<WalletFetchResult> {
  const res = await fetch(
    `/api/organizations/${orgId}/billing-account/wallet`,
  );
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

async function fetchTopUpStatus(
  orgId: string,
  topUpId: string,
): Promise<TopUpStatus | null> {
  const res = await fetch(
    `/api/organizations/${orgId}/billing-account/wallet/top-ups/${topUpId}`,
  );
  if (!res.ok) return null;
  return topUpStatusResponseSchema.parse(await res.json()).topUp;
}

async function pollTopUpUntilConfirmed(
  orgId: string,
  topUpId: string,
): Promise<TopUpStatus | null> {
  for (let attempt = 0; attempt < TOPUP_POLL_MAX_ATTEMPTS; attempt++) {
    const status = await fetchTopUpStatus(orgId, topUpId);
    if (status?.status === "confirmed") return status;
    await new Promise((r) => setTimeout(r, TOPUP_POLL_INTERVAL_MS));
  }
  return null;
}

function isWalletResponse(r: WalletFetchResult): r is WalletResponse {
  return "billingAccount" in r;
}

export function WalletTab({ orgId }: { orgId: string }) {
  const { isAtLeast } = useOrgRole(orgId);
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["org-wallet", orgId],
    queryFn: () => fetchWallet(orgId),
  });

  const [showBuy, setShowBuy] = useState(false);
  const [amountMajor, setAmountMajor] = useState("1000");
  const { toast } = useToast();

  const topUpMutation = useMutation({
    mutationFn: async (): Promise<TopUpMutationResult> => {
      const amountPaise = Math.round(parseFloat(amountMajor || "0") * 100);

      const contact = normalizeRazorpayContact(session?.user?.phone);
      if (!contact) {
        throw new Error(
          "Add a valid phone number to your profile before topping up. Razorpay rejects checkouts without a contact.",
        );
      }

      const result = await initiateTopUp(orgId, amountPaise);

      const loaded = await loadScript(
        "https://checkout.razorpay.com/v1/checkout.js",
      ).catch(() => false);
      if (!loaded || !window.Razorpay) {
        throw new Error(
          "Razorpay checkout failed to load. Please disable ad-blockers and retry.",
        );
      }
      const paid = await new Promise<boolean>((resolve) => {
        const rzp = new window.Razorpay({
          key: result.keyId,
          amount: result.amountPaise,
          currency: result.currency,
          name: "Familiarise",
          description: "Wallet top-up",
          order_id: result.razorpayOrderId,
          prefill: {
            ...(session?.user?.name ? { name: session.user.name } : {}),
            ...(session?.user?.email ? { email: session.user.email } : {}),
            contact,
          },
          handler: () => {
            resolve(true);
          },
          theme: { color: "#2563EB" },
        });
        rzp.on("payment.failed", () => {
          toast({
            title: "Payment failed",
            description:
              "Your card was declined or the payment timed out. Please try again.",
            variant: "destructive",
          });
          resolve(false);
        });
        rzp.open();
      });

      if (!paid) {
        return { result, outcome: "not_paid", confirmed: null };
      }

      const confirmed = await pollTopUpUntilConfirmed(orgId, result.topUpId);
      if (confirmed) {
        return { result, outcome: "confirmed", confirmed };
      }
      return { result, outcome: "pending", confirmed: null };
    },
    onSuccess: (data) => {
      setShowBuy(false);
      queryClient.invalidateQueries({ queryKey: ["org-wallet", orgId] });
      if (data.outcome === "confirmed") {
        toast({
          title: "Top-up confirmed",
          description: `₹${(data.confirmed.amountPaise / 100).toLocaleString("en-IN")} credited to your wallet.`,
        });
      } else if (data.outcome === "pending") {
        toast({
          title: "Payment received",
          description:
            "Awaiting confirmation from Razorpay. Your balance will update automatically once the webhook lands.",
        });
      }
    },
  });

  const walletResponse = data && isWalletResponse(data) ? data : null;
  const walletError = data && !isWalletResponse(data) ? data : null;

  return (
    <>
      {walletError ? (
        <Card>
          <CardHeader>
            <CardTitle>Wallet not enabled</CardTitle>
            <CardDescription>
              {walletError.error}
              {walletError.currentFundingSource && (
                <>
                  {" "}Current funding source:{" "}
                  <code>{walletError.currentFundingSource}</code>. Wallets only
                  apply to <code>WALLET</code>-funded organizations.
                </>
              )}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : isLoading || !walletResponse ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-zinc-700">Wallet balance</h3>
            {isAtLeast("OWNER") && (
              <Button size="sm" onClick={() => setShowBuy(true)}>
                <Plus className="h-4 w-4 mr-1" /> Top up
              </Button>
            )}
          </div>

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
                Minimum ₹100. Razorpay checkout will open in a popup; your
                wallet credit is added once payment is captured.
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
