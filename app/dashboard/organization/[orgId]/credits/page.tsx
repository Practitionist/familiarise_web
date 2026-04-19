"use client";

import { use, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Coins, Plus } from "lucide-react";
import { z } from "zod";

import { useOrgRole, useRequireOrgAccess } from "../useOrgRole";
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

// Poll budget for the post-checkout webhook race. Razorpay typically
// fires the webhook within 1–3s of capture, but the SLA is "best
// effort"; we cap at 20 attempts × 1s = 20s and then fall back to
// "awaiting confirmation" so the UI never stalls indefinitely.
const TOPUP_POLL_INTERVAL_MS = 1000;
const TOPUP_POLL_MAX_ATTEMPTS = 20;

// Discriminated union for the post-checkout flow:
//   - "confirmed": webhook landed within the poll budget; show the
//      credited amount.
//   - "pending":   capture succeeded but the webhook is slow; show
//      "awaiting confirmation" — balance will catch up on its own.
//   - "not_paid":  user dismissed the popup or `payment.failed` fired
//      (already toasted); the success handler stays silent.
type TopUpMutationResult =
  | { result: TopUpInitiateResponse; outcome: "confirmed"; confirmed: TopUpStatus }
  | { result: TopUpInitiateResponse; outcome: "pending"; confirmed: null }
  | { result: TopUpInitiateResponse; outcome: "not_paid"; confirmed: null };

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

/**
 * Poll the top-up endpoint until the webhook flips status to
 * `confirmed` or we exhaust the budget. Returns the confirmed entry,
 * or `null` if the budget elapsed without confirmation (in which case
 * the caller should surface "awaiting confirmation").
 *
 * The webhook is the source of truth — this is purely a UX bridge so
 * the dashboard reflects the settled balance without forcing the user
 * to refresh manually after a successful Razorpay capture.
 */
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
  // MANAGER can view wallet; top-up API is OWNER-only (touches money).
  // Render the page either way but hide the Top-up CTA for non-owners.
  const { isAtLeast } = useOrgRole(orgId);
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
    mutationFn: async (): Promise<TopUpMutationResult> => {
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
      // The popup resolves with `paid: true` if Razorpay called our
      // `handler` (capture succeeded), `paid: false` if `payment.failed`
      // fired or the user dismissed the popup. We only poll for webhook
      // confirmation in the success branch.
      const paid = await new Promise<boolean>((resolve) => {
        const rzp = new window.Razorpay({
          key: result.keyId,
          amount: result.amountPaise,
          currency: result.currency,
          name: "Familiarise",
          description: "Wallet top-up",
          order_id: result.razorpayOrderId,
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
        // payment.failed already toasted (or popup dismissed) — skip
        // polling and stay silent in the success handler.
        return { result, outcome: "not_paid", confirmed: null };
      }

      // Bounded polling bridges the webhook-settlement race so the
      // dashboard reflects the credited balance without a manual
      // refresh. The capture is still safe even on timeout (webhook
      // is idempotent on `WalletEntry.providerOrderId`); we just fall
      // back to an "awaiting confirmation" toast.
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
      // outcome === "not_paid" — already handled by the payment.failed
      // toast or the user dismissed the popup; stay silent.
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
          walletResponse && isAtLeast("OWNER") && (
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
