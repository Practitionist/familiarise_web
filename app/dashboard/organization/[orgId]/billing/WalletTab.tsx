"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Coins, Plus } from "lucide-react";
import { z } from "zod";
import { topUpStatusSchema, type TopUpStatus } from "@/schemas/wallet";

import { useOrgRole } from "../useOrgRole";
import { useToast } from "@/hooks/use-toast";
import { loadScript } from "@/app/checkout/plans/utils";
import { useSession } from "@/lib/auth-client";
import { normalizeRazorpayContact } from "@/lib/payments/razorpay-prefill";
import {
  buildCheckoutOptions,
  type RazorpayCheckoutResponse,
} from "@/lib/payments/client/checkout-options";
import { DashboardGrid } from "@/components/dashboard/PageScaffold";
import { StatCard } from "@/components/dashboard/StatCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import { formatCurrencyAmount } from "@/utils/formatting";
import { humanizeEnum } from "@/lib/ui/tone";

const walletResponseSchema = z.object({
  billingAccount: z.object({
    id: z.string(),
    currency: z.string(),
    walletBalance: z.number(),
    // #777 §C — balance-alert config.
    minBalancePaise: z.number().nullable(),
    autoTopUpEnabled: z.boolean(),
    autoTopUpAmountPaise: z.number().nullable(),
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
  // Recent top-ups the gateway has not confirmed yet, newest first.
  pendingTopUps: z.array(
    z.object({
      topUpId: z.string(),
      amountPaise: z.number(),
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
    status: topUpStatusSchema,
    amountPaise: z.number(),
    // `balanceAfter` used to be required here and the route does not return it.
    // Nothing read it, so it existed only to reject every response.
    createdAt: z.string(),
  }),
});
type TopUpSnapshot = z.infer<typeof topUpStatusResponseSchema>["topUp"];

const apiErrorSchema = z.object({
  error: z.string().optional(),
  errorType: z.string().optional(),
});

const TOPUP_POLL_INTERVAL_MS = 1000;
const TOPUP_POLL_MAX_ATTEMPTS = 20;
/** How often a top-up still awaiting the gateway is re-checked in the background. */
const TOPUP_PENDING_REFETCH_MS = 5000;

type TopUpMutationResult =
  | {
      result: TopUpInitiateResponse;
      outcome: "settled";
      settled: TopUpSnapshot;
    }
  | { result: TopUpInitiateResponse; outcome: "pending"; settled: null }
  | { result: TopUpInitiateResponse; outcome: "not_paid"; settled: null };

/** The toast for a top-up the gateway has settled, confirmed or failed. */
function settledTopUpToast(
  status: Exclude<TopUpStatus, "pending">,
  amountPaise: number,
) {
  return status === "confirmed"
    ? {
        title: "Top-up confirmed",
        description: `₹${(amountPaise / 100).toLocaleString("en-IN")} credited to your wallet.`,
      }
    : {
        title: "Top-up failed",
        description: "The payment was not captured. Nothing was credited.",
        variant: "destructive" as const,
      };
}

async function fetchWallet(orgId: string): Promise<WalletFetchResult> {
  const res = await fetch(`/api/organizations/${orgId}/billing-account/wallet`);
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

// #777 §C — persist the balance-alert config via the billing-account PATCH.
// NOTIFY-ONLY floor: the toggle drives whether a minimum is set (cron alerts
// off minBalancePaise alone); autoTopUpEnabled stays false until mandates land
// — the API rejects enabling it without an autoTopUpAmountPaise anyway.
async function patchBalanceAlerts(
  orgId: string,
  body: {
    minBalancePaise: number | null;
  },
): Promise<void> {
  const res = await fetch(`/api/organizations/${orgId}/billing-account`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const parsedError = apiErrorSchema.safeParse(
      await res.json().catch(() => null),
    );
    throw new Error(
      parsedError.success
        ? (parsedError.data.error ?? "Failed to save balance alerts")
        : "Failed to save balance alerts",
    );
  }
}

async function fetchTopUpStatus(
  orgId: string,
  topUpId: string,
): Promise<TopUpSnapshot | null> {
  const res = await fetch(
    `/api/organizations/${orgId}/billing-account/wallet/top-ups/${topUpId}`,
  );
  if (!res.ok) return null;
  return topUpStatusResponseSchema.parse(await res.json()).topUp;
}

/** Drives the server-side confirmation from the Checkout response; the webhook stays the backstop. */
async function verifyTopUp(
  orgId: string,
  topUpId: string,
  response: RazorpayCheckoutResponse,
): Promise<void> {
  // Best effort: the status poll reads the outcome and the webhook backstops it.
  await fetch(
    `/api/organizations/${orgId}/billing-account/wallet/top-ups/${topUpId}/verify`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        razorpay_order_id: response.razorpay_order_id,
        razorpay_payment_id: response.razorpay_payment_id,
        razorpay_signature: response.razorpay_signature,
      }),
    },
  );
}

/** The top-up once confirmed or failed, or null while still pending. */
async function pollTopUpUntilSettled(
  orgId: string,
  topUpId: string,
): Promise<TopUpSnapshot | null> {
  for (let attempt = 0; attempt < TOPUP_POLL_MAX_ATTEMPTS; attempt++) {
    const status = await fetchTopUpStatus(orgId, topUpId);
    if (status && status.status !== "pending") return status;
    await new Promise((r) => setTimeout(r, TOPUP_POLL_INTERVAL_MS));
  }
  return null;
}

function isWalletResponse(r: WalletFetchResult): r is WalletResponse {
  return "billingAccount" in r;
}

export function WalletTab({
  orgId,
  // #779 §B: when the org isn't ACTIVE the server rejects top-ups; these
  // props let the tab disable the affordance instead of a dead click.
  moneyMoveBlocked = false,
  moneyMoveReason,
}: {
  orgId: string;
  moneyMoveBlocked?: boolean;
  moneyMoveReason?: string;
}) {
  // #1132 — top-up is `billing.manage` (OWNER + BILLING_ADMIN), not a rank
  // floor. The server has always authorised BILLING_ADMIN here.
  const { can } = useOrgRole(orgId);
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["org-wallet", orgId],
    queryFn: () => fetchWallet(orgId),
  });
  const walletResponse = data && isWalletResponse(data) ? data : null;
  const walletError = data && !isWalletResponse(data) ? data : null;

  const [showBuy, setShowBuy] = useState(false);
  const [amountMajor, setAmountMajor] = useState("1000");
  // #777 §C — balance-alert config draft. Seeded from the loaded account once
  // it lands (see effect below) so the inputs reflect persisted state.
  const [minBalanceMajor, setMinBalanceMajor] = useState("");
  const [alertsEnabled, setAlertsEnabled] = useState(false);
  const { toast } = useToast();
  // Server-derived, so the pending banner survives a reload.
  const pendingTopUpId = walletResponse?.pendingTopUps[0]?.topUpId ?? null;
  // Settled top-ups already toasted, so the checkout flow and the poll never both announce one.
  const announcedTopUpIds = useRef(new Set<string>());

  const pendingTopUp = useQuery({
    queryKey: ["org-wallet-top-up", orgId, pendingTopUpId],
    queryFn: () => fetchTopUpStatus(orgId, pendingTopUpId ?? ""),
    enabled: pendingTopUpId !== null,
    refetchInterval: TOPUP_PENDING_REFETCH_MS,
  });
  const settledTopUpId = pendingTopUp.data?.topUpId;
  const pendingTopUpStatus = pendingTopUp.data?.status;
  const pendingTopUpAmount = pendingTopUp.data?.amountPaise;
  useEffect(() => {
    if (
      !settledTopUpId ||
      (pendingTopUpStatus !== "confirmed" && pendingTopUpStatus !== "failed")
    )
      return;
    queryClient.invalidateQueries({ queryKey: ["org-wallet", orgId] });
    if (announcedTopUpIds.current.has(settledTopUpId)) return;
    announcedTopUpIds.current.add(settledTopUpId);
    toast(settledTopUpToast(pendingTopUpStatus, pendingTopUpAmount ?? 0));
  }, [
    settledTopUpId,
    pendingTopUpStatus,
    pendingTopUpAmount,
    orgId,
    queryClient,
    toast,
  ]);

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
      const paid = await new Promise<RazorpayCheckoutResponse | null>(
        (resolve) => {
          const rzp = new window.Razorpay(
            buildCheckoutOptions({
              keyId: result.keyId,
              amount: result.amountPaise,
              currency: result.currency,
              name: "Familiarise",
              description: "Wallet top-up",
              orderId: result.razorpayOrderId,
              prefill: {
                ...(session?.user?.name ? { name: session.user.name } : {}),
                ...(session?.user?.email ? { email: session.user.email } : {}),
                contact,
              },
              handler: (response) => {
                resolve(response);
              },
              theme: { color: "#2563EB" },
            }),
          );
          rzp.on("payment.failed", () => {
            toast({
              title: "Payment failed",
              description:
                "Your card was declined or the payment timed out. Please try again.",
              variant: "destructive",
            });
            resolve(null);
          });
          rzp.open();
        },
      );

      if (!paid) {
        return { result, outcome: "not_paid", settled: null };
      }

      await verifyTopUp(orgId, result.topUpId, paid).catch(() => undefined);
      const settled = await pollTopUpUntilSettled(orgId, result.topUpId);
      if (settled) {
        return { result, outcome: "settled", settled };
      }
      return { result, outcome: "pending", settled: null };
    },
    onSuccess: (data) => {
      setShowBuy(false);
      queryClient.invalidateQueries({ queryKey: ["org-wallet", orgId] });
      if (data.outcome === "settled") {
        announcedTopUpIds.current.add(data.result.topUpId);
        const { status, amountPaise } = data.settled;
        if (status !== "pending") toast(settledTopUpToast(status, amountPaise));
      } else if (data.outcome === "pending") {
        // The pending banner keeps polling and announces the final status.
        toast({
          title: "Top-up pending",
          description:
            "The payment is still being confirmed. Your balance updates once it lands.",
        });
      }
    },
  });

  // #777 §C — finance can see + edit balance alerts. billing.read includes
  // MANAGER (read-only); the PATCH gate is billing.manage, so only those
  // holders save (#1851: the same keys as the routes).
  const canSeeAlerts = can("billing.read");
  const canEditAlerts = can("billing.manage");

  // Seed the draft from the persisted account once it loads, keyed on the
  // returned config so a server-side change re-syncs the inputs. Alerts are
  // "on" whenever a minimum is set — the cron keys off minBalancePaise alone.
  // `undefined` until the account loads; `null` means alerts are off.
  const persistedMinBalance = walletResponse?.billingAccount.minBalancePaise;
  useEffect(() => {
    if (persistedMinBalance === undefined) return;
    setMinBalanceMajor(
      persistedMinBalance === null ? "" : String(persistedMinBalance / 100),
    );
    setAlertsEnabled(persistedMinBalance !== null);
  }, [persistedMinBalance]);

  const alertsMutation = useMutation({
    mutationFn: async () => {
      const trimmed = minBalanceMajor.trim();
      const parsed =
        trimmed === "" ? null : Math.round(Number.parseFloat(trimmed) * 100);
      // Toggle off (or a cleared field) clears the floor; toggle on needs a
      // valid amount so the cron has a threshold to compare against.
      if (
        alertsEnabled &&
        (parsed === null || parsed < 0 || Number.isNaN(parsed))
      ) {
        throw new Error("Set a valid minimum balance to enable alerts.");
      }
      await patchBalanceAlerts(orgId, {
        minBalancePaise: alertsEnabled ? parsed : null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-wallet", orgId] });
      toast({ title: "Balance alerts saved" });
    },
    onError: (err) => {
      toast({
        title: "Could not save balance alerts",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    },
  });

  // Ledger currency is read off the loaded account; the table below only
  // renders when walletResponse is present, so the "INR" fallback is inert.
  const ledgerCurrency = walletResponse?.billingAccount.currency ?? "INR";
  const ledgerColumns: ResponsiveColumn<WalletResponse["ledger"][number]>[] = [
    {
      key: "when",
      header: "When",
      primary: true,
      className: "text-xs text-muted-foreground",
      cell: (row) => new Date(row.createdAt).toLocaleString(),
    },
    {
      key: "reason",
      header: "Reason",
      className: "text-sm",
      cell: (row) => (
        <>
          {humanizeEnum(row.reason)}
          {row.notes && (
            <span className="text-xs text-muted-foreground block">
              {row.notes}
            </span>
          )}
        </>
      ),
    },
    {
      key: "delta",
      header: "Δ",
      headClassName: "text-right",
      cell: (row) => (
        <span
          className={`font-mono ${
            row.deltaPaise >= 0 ? "text-emerald-600" : "text-red-600"
          }`}
        >
          {row.deltaPaise >= 0 ? "+" : ""}
          {formatCurrencyAmount(row.deltaPaise, ledgerCurrency)}
        </span>
      ),
      className: "text-right",
    },
    {
      key: "balance",
      header: "Balance",
      headClassName: "text-right",
      className: "text-right font-mono text-sm",
      cell: (row) => formatCurrencyAmount(row.balanceAfter, ledgerCurrency),
    },
  ];

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
                  {" "}
                  This organization is funded by{" "}
                  {humanizeEnum(walletError.currentFundingSource)}; a wallet
                  applies only to prepaid-wallet organizations.
                </>
              )}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : isError ? (
        // This branch did not exist, and `isLoading || !walletResponse` sent a
        // failed fetch back to "Loading…" — so a payload the client refused to
        // parse presented as a tab that never finished loading, indistinguishable
        // from a slow network.
        <div className="text-sm">
          <p className="text-destructive">Couldn&apos;t load the wallet.</p>
          <p className="text-muted-foreground mt-1">
            {error instanceof Error ? error.message : "Please try again."}
          </p>
        </div>
      ) : isLoading || !walletResponse ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-foreground">
              Wallet balance
            </h3>
            {can("billing.manage") && (
              <div className="flex flex-col items-end gap-1">
                <Button
                  size="sm"
                  onClick={() => setShowBuy(true)}
                  disabled={moneyMoveBlocked}
                  title={moneyMoveBlocked ? moneyMoveReason : undefined}
                >
                  <Plus className="h-4 w-4 mr-1" /> Top up
                </Button>
                {moneyMoveBlocked && moneyMoveReason && (
                  <span className="text-xs text-amber-600">
                    {moneyMoveReason}
                  </span>
                )}
              </div>
            )}
          </div>

          {pendingTopUpId && (
            <output className="mb-4 block rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
              Top-up pending — waiting for Razorpay to confirm a recent payment.
              Your balance updates here once it does.
            </output>
          )}

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
              <ResponsiveTable<WalletResponse["ledger"][number]>
                columns={ledgerColumns}
                rows={walletResponse.ledger}
                getRowId={(row) => row.id}
                empty={
                  <p className="text-center text-sm text-muted-foreground py-6">
                    No activity yet.
                  </p>
                }
              />
            </CardContent>
          </Card>

          {/* #777 §C — balance alerts (NOTIFY-ONLY floor). */}
          {canSeeAlerts && (
            <Card className="mt-6">
              <CardHeader>
                <CardTitle className="text-base">Balance alerts</CardTitle>
                <CardDescription>
                  Email finance when the balance dips below the minimum —
                  automatic top-up arrives with payment mandates.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2 max-w-xs">
                  <Label htmlFor="min-balance">Minimum balance (₹)</Label>
                  <Input
                    id="min-balance"
                    type="number"
                    min="0"
                    step="100"
                    value={minBalanceMajor}
                    disabled={
                      !canEditAlerts ||
                      !alertsEnabled ||
                      alertsMutation.isPending
                    }
                    onChange={(e) => setMinBalanceMajor(e.target.value)}
                  />
                </div>
                <div className="flex items-center gap-3">
                  <Switch
                    id="alerts-enabled"
                    checked={alertsEnabled}
                    disabled={!canEditAlerts || alertsMutation.isPending}
                    onCheckedChange={setAlertsEnabled}
                  />
                  <Label htmlFor="alerts-enabled" className="font-normal">
                    Email finance when the balance dips below the minimum
                  </Label>
                </div>
                {canEditAlerts && (
                  <Button
                    size="sm"
                    onClick={() => alertsMutation.mutate()}
                    disabled={alertsMutation.isPending}
                  >
                    {alertsMutation.isPending ? "Saving…" : "Save alerts"}
                  </Button>
                )}
                {/* #863 residual — the auto-top-up executor (RBI e-mandate:
                    ₹15k AFA-free cap + 24h pre-debit notice) is NOT built. The
                    autoTopUp* columns + settings CRUD exist as config-of-intent;
                    nothing fires a debit. TODO(#863): build the mandate +
                    executor when a design partner needs it. Notify-only for now. */}
                <div className="rounded-md border border-dashed border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    Automatic top-up — coming soon.
                  </span>{" "}
                  Today we email finance to top up the wallet manually;
                  auto-debit arrives with RBI-compliant payment mandates.
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}

      <ResponsiveModal open={showBuy} onOpenChange={setShowBuy}>
        <ResponsiveModalContent>
          <ResponsiveModalHeader>
            <ResponsiveModalTitle>Top up wallet</ResponsiveModalTitle>
          </ResponsiveModalHeader>
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
              <p className="text-xs text-muted-foreground">
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
          <ResponsiveModalFooter>
            <Button variant="outline" onClick={() => setShowBuy(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => topUpMutation.mutate()}
              disabled={topUpMutation.isPending}
            >
              {topUpMutation.isPending ? "Initiating…" : "Continue"}
            </Button>
          </ResponsiveModalFooter>
        </ResponsiveModalContent>
      </ResponsiveModal>
    </>
  );
}
