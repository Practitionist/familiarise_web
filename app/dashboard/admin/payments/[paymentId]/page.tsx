"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { use, useState } from "react";
import { formatCurrencyAmount } from "@/lib/utils";
import type {
  PaymentDetail,
  PaymentDetailRefund,
  PaymentDetailDispute,
} from "@/types/payments";

// Fetch payment details
async function fetchPaymentDetails(paymentId: string): Promise<PaymentDetail> {
  const response = await fetch(`/api/admin/payments/${paymentId}`);
  if (!response.ok) {
    throw new Error("Failed to fetch payment details");
  }
  return response.json() as Promise<PaymentDetail>;
}

// Create refund
async function createRefund(data: {
  paymentId: string;
  amount?: number;
  reason?: string;
}) {
  const response = await fetch("/api/payments/refunds", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to create refund");
  }

  return response.json();
}

interface PageProps {
  params: Promise<{ paymentId: string }>;
}

export default function PaymentDetailsPage({ params }: PageProps) {
  const resolvedParams = use(params);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [showRefundForm, setShowRefundForm] = useState(false);

  const {
    data: payment,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["admin-payment", resolvedParams.paymentId],
    queryFn: () => fetchPaymentDetails(resolvedParams.paymentId),
    staleTime: 30 * 1000,
  });

  const refundMutation = useMutation({
    mutationFn: createRefund,
    onSuccess: () => {
      toast({
        title: "Refund Created",
        description: "The refund has been initiated successfully.",
      });
      queryClient.invalidateQueries({
        queryKey: ["admin-payment", resolvedParams.paymentId],
      });
      setShowRefundForm(false);
      setRefundAmount("");
      setRefundReason("");
    },
    onError: (error: Error) => {
      toast({
        title: "Refund Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleRefund = () => {
    refundMutation.mutate({
      paymentId: resolvedParams.paymentId,
      amount: refundAmount ? parseFloat(refundAmount) : undefined,
      reason: refundReason || undefined,
    });
  };

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-red-600">Error</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-gray-700">
              {error instanceof Error
                ? error.message
                : "Failed to load payment details"}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading || !payment) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-48" />
          </CardHeader>
          <CardContent className="space-y-4">
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Link
            href="/dashboard/admin/payments"
            className="text-sm text-blue-600 hover:text-blue-700 mb-2 inline-block"
          >
            ← Back to Payments
          </Link>
          <h1 className="text-3xl font-bold text-gray-900">Payment Details</h1>
        </div>
        {payment.paymentStatus === "SUCCEEDED" && !showRefundForm && (
          <Button onClick={() => setShowRefundForm(true)} variant="destructive">
            Issue Refund
          </Button>
        )}
      </div>

      {/* Payment Info */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Payment Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-gray-500">Payment Intent ID</Label>
              <p className="font-mono text-sm">{payment.paymentIntent}</p>
            </div>
            <div>
              <Label className="text-gray-500">Amount</Label>
              <p className="text-2xl font-bold">
                {formatCurrencyAmount(payment.amount, payment.currency)}
              </p>
            </div>
            <div>
              <Label className="text-gray-500">Status</Label>
              <div className="mt-1">
                <span
                  className={`px-3 py-1 rounded text-sm font-medium ${
                    payment.paymentStatus === "SUCCEEDED"
                      ? "bg-green-100 text-green-800"
                      : payment.paymentStatus === "PENDING"
                        ? "bg-yellow-100 text-yellow-800"
                        : "bg-red-100 text-red-800"
                  }`}
                >
                  {payment.paymentStatus}
                </span>
              </div>
            </div>
            <div>
              <Label className="text-gray-500">Payment Gateway</Label>
              <p className="font-medium">{payment.paymentGateway}</p>
            </div>
            <div>
              <Label className="text-gray-500">Payment Type</Label>
              <p className="font-medium">
                {payment.isMockPayment ? (
                  <span className="px-2 py-1 rounded text-sm font-medium bg-purple-100 text-purple-800">
                    MOCK PAYMENT
                  </span>
                ) : (
                  "Real Payment"
                )}
              </p>
            </div>
            <div>
              <Label className="text-gray-500">Created At</Label>
              <p>{new Date(payment.createdAt).toLocaleString()}</p>
            </div>
            {payment.expiresAt && (
              <div>
                <Label className="text-gray-500">Expires At</Label>
                <p>{new Date(payment.expiresAt).toLocaleString()}</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Appointment Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {payment.appointment ? (
              <>
                <div>
                  <Label className="text-gray-500">Appointment Type</Label>
                  <p className="font-medium">
                    {payment.appointment.appointmentType}
                  </p>
                </div>
                <div>
                  <Label className="text-gray-500">Appointment ID</Label>
                  <p className="font-mono text-sm">{payment.appointment.id}</p>
                </div>
                <div>
                  <Label className="text-gray-500">User</Label>
                  <p>{payment.user?.name || "N/A"}</p>
                  <p className="text-sm text-gray-500">{payment.user?.email}</p>
                </div>
              </>
            ) : (
              <p className="text-gray-500">No appointment associated yet</p>
            )}

            {payment.discountCode && (
              <div>
                <Label className="text-gray-500">Discount Code</Label>
                <p className="font-medium">{payment.discountCode.code}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Refund Form */}
      {showRefundForm && (
        <Card className="border-red-200">
          <CardHeader>
            <CardTitle className="text-red-600">Issue Refund</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="refundAmount">
                Refund Amount (leave empty for full refund)
              </Label>
              {/* H7 FIX: Calculate remaining refundable balance accounting for
                  already-processed refunds to prevent over-refunding */}
              {(() => {
                const successfulRefunds = (payment.refunds || [])
                  .filter((r: PaymentDetailRefund) => r.status === "SUCCEEDED" || r.status === "PENDING")
                  .reduce((sum: number, r: PaymentDetailRefund) => sum + r.amount, 0);
                const remainingRefundable = payment.amount - successfulRefunds;
                return (
                  <>
                    <Input
                      id="refundAmount"
                      type="number"
                      placeholder={`Max: ${formatCurrencyAmount(remainingRefundable, payment.currency)}`}
                      value={refundAmount}
                      onChange={(e) => setRefundAmount(e.target.value)}
                      max={remainingRefundable}
                      min={1}
                    />
                    {successfulRefunds > 0 && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Already refunded: {formatCurrencyAmount(successfulRefunds, payment.currency)} • Remaining: {formatCurrencyAmount(remainingRefundable, payment.currency)}
                      </p>
                    )}
                  </>
                );
              })()}
            </div>
            <div>
              <Label htmlFor="refundReason">Reason (optional)</Label>
              <Textarea
                id="refundReason"
                placeholder="Enter refund reason..."
                value={refundReason}
                onChange={(e) => setRefundReason(e.target.value)}
                rows={3}
              />
            </div>
            <div className="flex gap-2">
              <Button
                onClick={handleRefund}
                variant="destructive"
                disabled={refundMutation.isPending}
              >
                {refundMutation.isPending ? "Processing..." : "Confirm Refund"}
              </Button>
              <Button
                onClick={() => setShowRefundForm(false)}
                variant="outline"
                disabled={refundMutation.isPending}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Refunds List */}
      {payment.refunds && payment.refunds.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Refunds</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {payment.refunds.map((refund: PaymentDetailRefund) => (
                <div
                  key={refund.id}
                  className="p-4 border rounded-lg flex justify-between items-start"
                >
                  <div>
                    <p className="font-medium">
                      {formatCurrencyAmount(refund.amount, refund.currency)}
                    </p>
                    <p className="text-sm text-gray-500">{refund.reason}</p>
                    <p className="text-xs text-gray-400 mt-1">
                      {new Date(refund.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <span
                    className={`px-2 py-1 rounded text-xs font-medium ${
                      refund.status === "SUCCEEDED"
                        ? "bg-green-100 text-green-800"
                        : refund.status === "PENDING"
                          ? "bg-yellow-100 text-yellow-800"
                          : "bg-red-100 text-red-800"
                    }`}
                  >
                    {refund.status}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Disputes List */}
      {payment.disputes && payment.disputes.length > 0 && (
        <Card className="border-red-200">
          <CardHeader>
            <CardTitle className="text-red-600">Disputes</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {payment.disputes.map((dispute: PaymentDetailDispute) => (
                <Link
                  key={dispute.id}
                  href={`/dashboard/admin/disputes/${dispute.id}`}
                  className="block p-4 border rounded-lg hover:bg-gray-50 transition-colors"
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="font-medium">
                        {formatCurrencyAmount(dispute.amount, dispute.currency)}
                      </p>
                      <p className="text-sm text-gray-600">{dispute.reason}</p>
                      <p className="text-xs text-gray-400 mt-1">
                        {new Date(dispute.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <span
                      className={`px-2 py-1 rounded text-xs font-medium ${
                        dispute.status === "WON"
                          ? "bg-green-100 text-green-800"
                          : dispute.status === "LOST"
                            ? "bg-red-100 text-red-800"
                            : "bg-yellow-100 text-yellow-800"
                      }`}
                    >
                      {dispute.status}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
