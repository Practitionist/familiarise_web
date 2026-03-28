"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  CreditCard,
  AlertTriangle,
  AlertCircle,
  Clock,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useCurrency } from "@/hooks/useCurrency";
import { cn } from "@/utils/tailwind";

interface PendingPayment {
  id: string;
  type: "consultation" | "subscription" | "webinar" | "class";
  title: string;
  consultantName: string;
  amount: number;
  currency: string;
  paymentUrl: string;
  approvedAt: string;
  expiresAt: string;
  isExpiringSoon: boolean;
  source?: "approval_pending" | "gateway_pending";
}

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
  const router = useRouter();
  const [pendingPayments, setPendingPayments] = useState<PendingPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchPendingPayments() {
      try {
        setLoading(true);
        const response = await fetch(
          `/api/dashboard/consultee/${consulteeId}/pending-payments`,
        );

        if (!response.ok) {
          throw new Error("Failed to fetch pending payments");
        }

        const data = await response.json();
        setPendingPayments(data.pendingPayments || []);
      } catch (err) {
        console.error("Error fetching pending payments:", err);
        setError(
          err instanceof Error
            ? err.message
            : "Failed to load pending payments",
        );
      } finally {
        setLoading(false);
      }
    }

    fetchPendingPayments();

    // Poll for updates every 2 minutes
    const interval = setInterval(fetchPendingPayments, 120000);
    return () => clearInterval(interval);
  }, [consulteeId]);

  if (loading) {
    return null;
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  // Empty state
  if (pendingPayments.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden h-full flex flex-col">
        <div className="px-5 py-4 border-b border-zinc-100 shrink-0">
          <h3 className="flex items-center gap-2 font-semibold text-zinc-900 text-sm">
            <CreditCard className="h-4 w-4 text-zinc-400" />
            Pending Payments
          </h3>
        </div>
        <div className="px-5 py-8 text-center flex-1 flex flex-col items-center justify-center">
          <div className="mx-auto h-10 w-10 rounded-full bg-emerald-50 flex items-center justify-center mb-2">
            <CreditCard className="h-5 w-5 text-emerald-500" />
          </div>
          <p className="text-sm text-zinc-500">No pending payments</p>
          <p className="text-xs text-zinc-400 mt-0.5">
            You&apos;re all caught up!
          </p>
        </div>
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
          ? "bg-amber-50 border-amber-300"
          : "bg-white border-amber-200",
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
      <div className="divide-y divide-amber-100 flex-1">
        {pendingPayments.map((payment) => {
          const isGatewayPending = payment.source === "gateway_pending";

          return (
            <div key={payment.id} className="px-5 py-3.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-zinc-900 truncate">
                    {payment.title}
                  </p>
                  <p className="text-xs text-zinc-500 mt-0.5 truncate">
                    with {payment.consultantName}
                  </p>
                </div>
                <span className="text-sm font-semibold text-zinc-900 tabular-nums shrink-0">
                  {formatPrice(payment.amount)}
                </span>
              </div>
              <div className="flex items-center justify-between mt-2.5">
                <div className="flex items-center gap-1 text-xs text-zinc-500">
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
                      Approved{" "}
                      {formatDistanceToNow(new Date(payment.approvedAt), {
                        addSuffix: true,
                      })}
                    </span>
                  )}
                </div>
                {isGatewayPending ? (
                  <span className="inline-flex items-center gap-1 h-7 px-3 text-xs font-semibold text-amber-700 bg-amber-100 rounded-md">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Processing
                  </span>
                ) : (
                  <Button
                    size="sm"
                    className="h-7 px-3 text-xs bg-amber-700 hover:bg-amber-800 text-white font-semibold"
                    onClick={() => {
                      if (
                        payment.paymentUrl &&
                        /^https?:\/\//.test(payment.paymentUrl)
                      ) {
                        window.open(
                          payment.paymentUrl,
                          "_blank",
                          "noopener,noreferrer",
                        );
                      }
                    }}
                  >
                    Pay Now
                    <ExternalLink className="ml-1 h-3 w-3" />
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {pendingPayments.length > 1 && (
        <div className="px-5 py-3 border-t border-amber-100">
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-amber-800 hover:text-amber-900 hover:bg-amber-100 text-xs font-semibold"
            onClick={() =>
              router.push(`/dashboard/consultee/${consulteeId}/payments`)
            }
          >
            View All Payments
          </Button>
        </div>
      )}
    </div>
  );
}
