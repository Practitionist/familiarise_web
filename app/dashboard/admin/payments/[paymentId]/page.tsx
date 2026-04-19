"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { use } from "react";
import { formatCurrencyAmount } from "@/utils/formatting";
import type {
  PaymentDetail,
  PaymentDetailRefund,
  PaymentDetailDispute,
} from "@/types/payments";

// Manual refunds ship with the live checkout/program wiring — the admin
// refund flow will rebuild on top of `WalletEntry` + `SettlementLedgerEntry`
// + `OrganizationEarnings.refundedAmountPaise`. Until then this page is
// read-only: operators can see refund history that the system wrote from
// automated paths (gateway-originated refunds, dispute resolutions).

async function fetchPaymentDetails(paymentId: string): Promise<PaymentDetail> {
  const response = await fetch(`/api/admin/payments/${paymentId}`);
  if (!response.ok) {
    throw new Error("Failed to fetch payment details");
  }
  return response.json() as Promise<PaymentDetail>;
}

interface PageProps {
  params: Promise<{ paymentId: string }>;
}

export default function PaymentDetailsPage({ params }: PageProps) {
  const resolvedParams = use(params);

  const {
    data: payment,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["admin-payment", resolvedParams.paymentId],
    queryFn: () => fetchPaymentDetails(resolvedParams.paymentId),
    staleTime: 30 * 1000,
  });

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
                      {formatCurrencyAmount(
                        refund.amount,
                        refund.currency,
                      )}
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
