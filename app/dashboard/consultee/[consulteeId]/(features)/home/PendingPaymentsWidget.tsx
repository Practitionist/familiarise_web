"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  CreditCard,
  AlertTriangle,
  AlertCircle,
  Clock,
  ExternalLink,
  Loader2,
  X,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useCurrency } from "@/hooks/useCurrency";
import { formatCurrencyAmount } from "@/utils/formatting";
import { cn } from "@/utils/tailwind";
import { OUTCOME_UNKNOWN_MESSAGE } from "@/lib/fetch-helpers";
import type { LapsedPayLink } from "@/lib/dashboard/lapsed-pay-links";
import { deriveBookingPresentation } from "@/lib/dashboard/money-state";
import { LapsedPayLinkRow } from "./LapsedPayLinkRow";
import { isExternalPayHref } from "@/lib/payments/pay-link-href";

interface PendingPayment {
  id: string;
  /** `trial` was missing here while the API had been emitting it since #1046. */
  type: "consultation" | "subscription" | "webinar" | "class" | "trial";
  title: string;
  consultantName: string;
  amount: number;
  currency: string;
  paymentUrl: string;
  approvedAt: string;
  expiresAt: string;
  isExpiringSoon: boolean;
  source?: "approval_pending" | "gateway_pending";
  /**
   * Appointment record id for approval-pending items — the cancel route
   * (`POST /api/appointments/[appointmentId]/cancel`) keys on Appointment,
   * not the consultation/subscription row that `id` refers to.
   */
  appointmentId?: string | null;
}

/**
 * The route's whole payload. HomeTab shares this query key, so both readers
 * must return the same shape (#1675 added the lapsed rows next to the list).
 */
export interface PendingPaymentsPayload {
  pendingPayments: PendingPayment[];
  lapsedPayLinks: LapsedPayLink[];
}

export async function fetchPendingPayments(
  consulteeId: string,
): Promise<PendingPaymentsPayload> {
  const response = await fetch(
    `/api/dashboard/consultee/${consulteeId}/pending-payments`,
  );
  if (!response.ok) {
    throw new Error("Failed to fetch pending payments");
  }
  const data = await response.json();
  return {
    pendingPayments: data.pendingPayments || [],
    lapsedPayLinks: data.lapsedPayLinks || [],
  };
}

/**
 * #1675 — the row's words come from the one derivation the detail page uses:
 * an approved, unpaid request is AWAITING_PAYMENT and its action is "Pay ₹X".
 */
function rowPresentation(payment: PendingPayment) {
  return deriveBookingPresentation(
    {
      appointmentType: payment.type.toUpperCase(),
      request: {
        status: "APPROVED_PENDING_PAYMENT",
        kind: payment.type.toUpperCase(),
        requestedAt: payment.approvedAt,
      },
      occurrences: [],
      payments: [
        {
          id: payment.id,
          paymentStatus: "PENDING",
          paymentMethod: "CARD",
          paymentGateway: "RAZORPAY",
          receiptUrl: null,
          consumerInvoice: null,
          amount: payment.amount,
          currency: payment.currency || "INR",
          createdAt: payment.approvedAt,
          expiresAt: payment.expiresAt,
        },
      ],
      refunds: [],
      disputes: [],
      childPayments: [],
      sponsorOrgName: null,
      holdExpiresAt: payment.expiresAt,
      names: { payer: "you", consultant: payment.consultantName },
    },
    "CONSULTEE",
  );
}

type PendingCancelTarget =
  | { kind: "gateway"; paymentId: string; title: string }
  | { kind: "approval"; appointmentId: string; title: string };

interface PendingPaymentsWidgetProps {
  consulteeId: string;
}

/**
 * Sidebar widget showing pending payments.
 * Shows two types:
 * 1. Approval-pending: consultant approved, awaiting checkout (shows "Pay Now")
 * 2. Gateway-pending: payment initiated, awaiting gateway confirmation (shows "Processing")
 */
export function PendingPaymentsWidget({
  consulteeId,
}: PendingPaymentsWidgetProps) {
  const { formatPrice } = useCurrency();
  const queryClient = useQueryClient();
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [cancelNotice, setCancelNotice] = useState<string | null>(null);

  // Refreshes on focus only — no timer.
  //
  // This was a manual setInterval, then a React Query refetchInterval, and is
  // now neither: someone waiting on a payment returns to the tab, and that is
  // when the refetch should fire. The global refetchOnWindowFocus is false, so
  // this query opts back in explicitly.
  const {
    data: payload,
    isLoading: loading,
    error: queryError,
  } = useQuery({
    queryKey: ["pending-payments", consulteeId],
    queryFn: () => fetchPendingPayments(consulteeId),
    // No interval: focus alone covers this. Someone waiting on a payment
    // comes back to the tab, which is exactly when the refetch fires.
    refetchOnWindowFocus: true,
    staleTime: 30 * 1000,
  });
  const pendingPayments = payload?.pendingPayments ?? [];
  const lapsedPayLinks = payload?.lapsedPayLinks ?? [];
  const error = queryError
    ? queryError instanceof Error
      ? queryError.message
      : "Failed to load pending payments"
    : null;

  const [cancelTarget, setCancelTarget] = useState<PendingCancelTarget | null>(
    null,
  );

  // #849 — release the caller's own tentative hold instead of waiting out
  // the 24h cleanup window.
  const cancelGatewayPending = useCallback(
    async (paymentId: string) => {
      setCancellingId(paymentId);
      setCancelNotice(null);
      try {
        const response = await fetch(`/api/checkout/pending/${paymentId}`, {
          method: "DELETE",
        });
        if (response.status === 409) {
          setCancelNotice(
            "This payment was already confirmed or expired — refreshing.",
          );
        } else if (!response.ok) {
          setCancelNotice("Could not cancel the pending booking. Try again.");
        }
        await queryClient.invalidateQueries({
          queryKey: ["pending-payments", consulteeId],
        });
      } catch {
        setCancelNotice("Could not cancel the pending booking. Try again.");
      } finally {
        setCancellingId(null);
      }
    },
    [queryClient, consulteeId],
  );

  // Cancel an APPROVED_PENDING_PAYMENT booking outright. The cancel route
  // allows this transition (CANCELLABLE_FROM) and skips refunds for unpaid
  // bookings, so this is the user-driven exit from the "pay or wait for
  // expiry" dead end. 409 = the booking already transitioned (e.g. payment
  // landed in another tab) — refresh rather than error.
  const cancelApprovalPending = useCallback(
    async (appointmentId: string) => {
      setCancellingId(appointmentId);
      setCancelNotice(null);
      try {
        const response = await fetch(
          `/api/appointments/${appointmentId}/cancel`,
          { method: "POST", headers: { "Content-Type": "application/json" } },
        );
        if (response.status === 409) {
          setCancelNotice("This booking already changed state — refreshing.");
        } else if (!response.ok) {
          const data = await response.json().catch(() => null);
          // A 5xx with no sentence is a timeout or crash: the cancel may
          // still have landed, so send them to look first (#1696).
          const fallback =
            response.status >= 500
              ? OUTCOME_UNKNOWN_MESSAGE
              : "Could not cancel the booking. Try again.";
          setCancelNotice(data?.error ?? fallback);
        }
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: ["pending-payments", consulteeId],
          }),
          queryClient.invalidateQueries({
            queryKey: ["consultee-events", consulteeId],
          }),
        ]);
      } catch {
        setCancelNotice("Could not cancel the booking. Try again.");
      } finally {
        setCancellingId(null);
      }
    },
    [queryClient, consulteeId],
  );

  const handleConfirmCancel = useCallback(() => {
    if (!cancelTarget) return;
    if (cancelTarget.kind === "gateway") {
      void cancelGatewayPending(cancelTarget.paymentId);
    } else {
      void cancelApprovalPending(cancelTarget.appointmentId);
    }
    setCancelTarget(null);
  }, [cancelTarget, cancelGatewayPending, cancelApprovalPending]);

  // Widget-shaped, not absent. `return null` collapsed the sidebar column and
  // then pushed everything back down when the query landed.
  if (loading) {
    return (
      <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden h-full flex flex-col">
        <div className="px-5 py-4 border-b border-border shrink-0">
          <h3 className="flex items-center gap-2 font-semibold text-foreground text-sm">
            <CreditCard className="h-4 w-4 text-muted-foreground/70" />
            Pending Payments
          </h3>
        </div>
        <div className="divide-y divide-border flex-1">
          {[0, 1].map((row) => (
            <div key={row} className="px-5 py-3.5 space-y-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="h-3.5 w-2/3 rounded bg-muted animate-pulse" />
                  <div className="h-3 w-1/3 rounded bg-muted animate-pulse" />
                </div>
                <div className="h-3.5 w-14 rounded bg-muted animate-pulse" />
              </div>
              <div className="flex items-center justify-between">
                <div className="h-3 w-24 rounded bg-muted animate-pulse" />
                <div className="h-7 w-20 rounded-md bg-muted animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  // #1675 — a lapsed link is not a pending payment, so it never turns the
  // card amber or joins the count; it sits under the list as a muted row.
  const lapsedSection = lapsedPayLinks.length > 0 && (
    <div className="divide-y divide-border">
      {lapsedPayLinks.map((link) => (
        <LapsedPayLinkRow key={link.id} link={link} />
      ))}
    </div>
  );

  // Empty state
  if (pendingPayments.length === 0) {
    return (
      <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden h-full flex flex-col">
        <div className="px-5 py-4 border-b border-border shrink-0">
          <h3 className="flex items-center gap-2 font-semibold text-foreground text-sm">
            <CreditCard className="h-4 w-4 text-muted-foreground/70" />
            Pending Payments
          </h3>
        </div>
        {lapsedSection || (
          <div className="px-5 py-8 text-center flex-1 flex flex-col items-center justify-center">
            <div className="mx-auto h-10 w-10 rounded-full bg-emerald-50 dark:bg-emerald-900/30 flex items-center justify-center mb-2">
              <CreditCard className="h-5 w-5 text-emerald-500 dark:text-emerald-300" />
            </div>
            <p className="text-sm text-muted-foreground">No pending payments</p>
            <p className="text-xs text-muted-foreground/70 mt-0.5">
              You&apos;re all caught up!
            </p>
          </div>
        )}
      </div>
    );
  }

  // Has payments
  const hasExpiring = pendingPayments.some((p) => p.isExpiringSoon);

  return (
    <div
      className={cn(
        "rounded-2xl border shadow-sm overflow-hidden h-full flex flex-col",
        hasExpiring
          ? "bg-amber-50 border-amber-300 dark:bg-amber-900/20 dark:border-amber-800"
          : "bg-card border-amber-200 dark:border-amber-900",
      )}
    >
      <div
        className={cn(
          "px-5 py-4 border-b flex items-center gap-2 shrink-0",
          hasExpiring ? "border-amber-200" : "border-amber-100",
        )}
      >
        <AlertTriangle className="h-4 w-4 text-amber-600" />
        <h3 className="font-semibold text-amber-900 text-sm">
          {pendingPayments.length} Pending{" "}
          {pendingPayments.length === 1 ? "Payment" : "Payments"}
        </h3>
      </div>
      {cancelNotice && (
        <div className="px-5 py-2 text-xs text-amber-800 bg-amber-100 border-b border-amber-200">
          {cancelNotice}
        </div>
      )}
      <div className="divide-y divide-amber-100 flex-1">
        {pendingPayments.map((payment) => {
          const isGatewayPending = payment.source === "gateway_pending";
          const { bookingState, nextAction } = rowPresentation(payment);
          // #1763 — `nextAction.label` runs its own `money()` helper, so an
          // INR row diverged from the row's own `formatPrice` amount above.
          const isNonInr =
            payment.currency && payment.currency.toUpperCase() !== "INR";
          const payLabel =
            nextAction.kind !== "PAY"
              ? "Pay now"
              : isNonInr
                ? nextAction.label
                : formatPrice(payment.amount);

          return (
            <div key={payment.id} className="px-5 py-3.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground truncate">
                    {payment.title}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">
                    with {payment.consultantName}
                  </p>
                </div>
                <span className="text-sm font-semibold text-foreground tabular-nums shrink-0">
                  {/* `formatPrice` assumes INR paise and applies the viewer's
                      FX rate, so a payment already denominated in another
                      currency was converted a second time and relabelled.
                      Only INR rows go through the converter now. */}
                  {payment.currency && payment.currency.toUpperCase() !== "INR"
                    ? formatCurrencyAmount(payment.amount, payment.currency)
                    : formatPrice(payment.amount)}
                </span>
              </div>
              <div className="flex items-center justify-between mt-2.5">
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Clock className="h-3 w-3" />
                  {payment.isExpiringSoon ? (
                    <span className="text-red-600 font-medium">
                      Expires{" "}
                      {formatDistanceToNow(new Date(payment.expiresAt), {
                        addSuffix: true,
                      })}
                    </span>
                  ) : isGatewayPending ? (
                    <span>
                      Initiated{" "}
                      {formatDistanceToNow(new Date(payment.approvedAt), {
                        addSuffix: true,
                      })}
                    </span>
                  ) : (
                    <span>
                      {bookingState.label} · approved{" "}
                      {formatDistanceToNow(new Date(payment.approvedAt), {
                        addSuffix: true,
                      })}
                    </span>
                  )}
                </div>
                {isGatewayPending ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="inline-flex items-center gap-1 h-7 px-3 text-xs font-semibold text-amber-700 bg-amber-100 rounded-md">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Processing
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={cancellingId === payment.id}
                      className="h-7 px-2 text-xs text-muted-foreground hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 font-semibold"
                      onClick={() =>
                        setCancelTarget({
                          kind: "gateway",
                          paymentId: payment.id,
                          title: payment.title,
                        })
                      }
                    >
                      {cancellingId === payment.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <>
                          <X className="h-3 w-3 mr-0.5" />
                          Cancel
                        </>
                      )}
                    </Button>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    {payment.appointmentId && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={cancellingId === payment.appointmentId}
                        className="h-7 px-2 text-xs text-muted-foreground hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 font-semibold"
                        onClick={() =>
                          setCancelTarget({
                            kind: "approval",
                            appointmentId: payment.appointmentId!,
                            title: payment.title,
                          })
                        }
                      >
                        {cancellingId === payment.appointmentId ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <>
                            <X className="h-3 w-3 mr-0.5" />
                            Cancel
                          </>
                        )}
                      </Button>
                    )}
                    {/* #1167 — a trial has a branded checkout page of our
                        own (`payment.id` IS the Trial id here), which
                        shows the amount, the duration and the hold deadline
                        before handing off to the gateway: a prefetching
                        Link. Everything else still opens the gateway link
                        directly in a new tab. */}
                    {payment.type === "trial" ? (
                      <Button
                        asChild
                        size="sm"
                        className="h-7 px-3 text-xs bg-amber-700 hover:bg-amber-800 text-white font-semibold"
                      >
                        <Link href={`/checkout/plans/trial/${payment.id}`}>
                          {payLabel}
                        </Link>
                      </Button>
                    ) : payment.paymentUrl &&
                      !isExternalPayHref(payment.paymentUrl) ? (
                      // #1775 P-1 — our pay page opens the existing order.
                      <Button
                        asChild
                        size="sm"
                        className="h-7 px-3 text-xs bg-amber-700 hover:bg-amber-800 text-white font-semibold"
                      >
                        <Link href={payment.paymentUrl}>{payLabel}</Link>
                      </Button>
                    ) : isExternalPayHref(payment.paymentUrl ?? "") ? (
                      <Button
                        asChild
                        size="sm"
                        className="h-7 px-3 text-xs bg-amber-700 hover:bg-amber-800 text-white font-semibold"
                      >
                        <a
                          href={payment.paymentUrl as string}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {payLabel}
                          <ExternalLink className="ml-1 h-3 w-3" />
                        </a>
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        disabled
                        className="h-7 px-3 text-xs bg-amber-700 text-white font-semibold"
                      >
                        {payLabel}
                        <ExternalLink className="ml-1 h-3 w-3" />
                      </Button>
                    )}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {lapsedSection && (
        <div className="border-t border-amber-100">{lapsedSection}</div>
      )}
      {pendingPayments.length > 1 && (
        <div className="px-5 py-3 border-t border-amber-100">
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="w-full text-amber-800 hover:text-amber-900 hover:bg-amber-100 text-xs font-semibold"
          >
            <Link href={`/dashboard/consultee/${consulteeId}/payments`}>
              View All Payments
            </Link>
          </Button>
        </div>
      )}

      <AlertDialog
        open={cancelTarget !== null}
        onOpenChange={(open) => {
          if (!open) setCancelTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {cancelTarget?.kind === "approval"
                ? "Cancel this booking request?"
                : "Cancel this pending payment?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {cancelTarget?.kind === "approval"
                ? `"${cancelTarget.title}" will be cancelled. Nothing has been charged — the consultant's approval and any held slots are released.`
                : `"${cancelTarget?.title ?? ""}" will be cancelled and your held slot released. If the payment already went through, it will be reconciled automatically.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep booking</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={handleConfirmCancel}
            >
              Cancel booking
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
