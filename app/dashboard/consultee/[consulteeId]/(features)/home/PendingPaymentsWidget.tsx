"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CreditCard, Clock, ExternalLink, AlertCircle } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { formatCurrencyAmount } from "@/utils/formatting";

interface PendingPayment {
  id: string;
  type: "consultation" | "subscription";
  title: string;
  consultantName: string;
  amount: number;
  currency: string;
  paymentUrl: string;
  approvedAt: string;
  expiresAt: string;
  isExpiringSoon: boolean; // < 24 hours
}

interface PendingPaymentsWidgetProps {
  consulteeId: string;
}

/**
 * Widget to display pending payments that require action from the consultee
 * Shows on the consultee home dashboard when there are approved requests awaiting payment
 */
export function PendingPaymentsWidget({
  consulteeId,
}: PendingPaymentsWidgetProps) {
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

  // Don't show the widget if there are no pending payments
  if (loading) {
    return null; // Or a skeleton loader if you prefer
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  if (pendingPayments.length === 0) {
    return null;
  }

  return (
    <Card className="border-amber-300 bg-amber-50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-amber-900">
          <CreditCard className="h-5 w-5" />
          Payment Required
        </CardTitle>
        <CardDescription className="text-amber-700">
          You have {pendingPayments.length}{" "}
          {pendingPayments.length === 1 ? "request" : "requests"} awaiting
          payment to proceed with scheduling
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {pendingPayments.map((payment) => (
          <div
            key={payment.id}
            className="bg-white rounded-lg p-4 border border-amber-200 shadow-sm"
          >
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <h4 className="font-semibold text-gray-900">{payment.title}</h4>
                <p className="text-sm text-gray-600 mt-1">
                  with{" "}
                  <span className="font-medium">{payment.consultantName}</span>
                </p>
                <div className="flex items-center gap-4 mt-2 text-sm">
                  <span className="font-semibold text-gray-900">
                    {formatCurrencyAmount(payment.amount, payment.currency)}
                  </span>
                  <span className="text-gray-500">•</span>
                  <span className="capitalize text-gray-600">
                    {payment.type}
                  </span>
                </div>
                <div className="flex items-center gap-1 mt-2 text-xs text-gray-500">
                  <Clock className="h-3 w-3" />
                  {payment.isExpiringSoon ? (
                    <span className="text-red-600 font-medium">
                      Expires{" "}
                      {formatDistanceToNow(new Date(payment.expiresAt), {
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
              </div>
              <Button
                size="sm"
                className="bg-amber-600 hover:bg-amber-700 text-white"
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
                <ExternalLink className="ml-2 h-3 w-3" />
              </Button>
            </div>

            {payment.isExpiringSoon && (
              <Alert variant="destructive" className="mt-3">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription className="text-xs">
                  This payment link expires soon! Complete payment within 24
                  hours or your request will be reverted to pending status.
                </AlertDescription>
              </Alert>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
