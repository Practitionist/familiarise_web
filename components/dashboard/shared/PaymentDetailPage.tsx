"use client";

import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { RefundDoorDialog } from "@/components/dashboard/backoffice/money/RefundDoorDialog";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Button } from "@/components/ui/button";
import { disputeStatus } from "@/lib/labels/backoffice-labels";
import { gatewayLabel } from "@/lib/labels/money-labels";
import {
  paymentStatusBadge,
  refundStatusBadge,
} from "@/lib/labels/session-labels";
import { humanizeEnum } from "@/lib/ui/tone";
import { formatCurrencyAmount } from "@/utils/formatting";
import type {
  PaymentDetail,
  PaymentDetailRefund,
  PaymentDetailDispute,
} from "@/types/payments";

// #1527 Q10 — admins issue a refund from here through the same console door
// as the Refunds page (`/api/admin/refunds/issue`), pre-filled with this
// payment and its refundable remainder; staff read only.

/**
 * Dispute states with a verdict behind them. Everything else is a proceeding
 * still in motion, and the gateway can advance it at any moment without the
 * operator doing anything — which is what the poll below is for.
 */
const TERMINAL_DISPUTE_STATUSES = new Set([
  "WON",
  "LOST",
  "CHARGE_REFUNDED",
  "CLOSED",
  "WARNING_CLOSED",
]);

async function fetchPaymentDetails(paymentId: string): Promise<PaymentDetail> {
  const response = await fetch(`/api/admin/payments/${paymentId}`);
  if (!response.ok) {
    throw new Error("Failed to fetch payment details");
  }
  return response.json() as Promise<PaymentDetail>;
}

export interface PaymentDetailPageProps {
  paymentId: string;
}

export function PaymentDetailPage({ paymentId }: PaymentDetailPageProps) {
  // #1527 — back-links and cross-links stay inside the viewer's tree.
  const { basePath, can } = useBackofficeCapability();
  const [refundOpen, setRefundOpen] = useState(false);
  const resolvedParams = { paymentId };

  const {
    data: payment,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["admin-payment", resolvedParams.paymentId],
    queryFn: () => fetchPaymentDetails(resolvedParams.paymentId),
    staleTime: 30 * 1000,
    // #1352 — a live dispute moves on the gateway's clock, not ours: the
    // webhook advances the row while the operator is sitting on this page
    // deciding whether to refund, and a 30-second stale window with no refetch
    // meant they could act on a status the platform had already superseded.
    // Poll only while a verdict is still outstanding; a resolved dispute never
    // changes again, so it goes back to costing nothing.
    refetchInterval: (query) =>
      query.state.data?.disputes?.some(
        (dispute) => !TERMINAL_DISPUTE_STATUSES.has(dispute.status),
      )
        ? 15 * 1000
        : false,
  });

  if (error && !payment) {
    return (
      <ErrorState
        title="This payment could not be loaded"
        onRetry={() => void refetch()}
        variant="page"
      />
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
      <PageHeader
        title="Payment details"
        back={{ href: `${basePath}/money/payments`, label: "Payments" }}
        actions={
          can("refunds.manage") && payment.paymentStatus === "SUCCEEDED" ? (
            <Button variant="outline" onClick={() => setRefundOpen(true)}>
              Issue refund
            </Button>
          ) : undefined
        }
      />
      {refundOpen && (
        <RefundDoorDialog
          door="issue"
          presetPaymentId={payment.id}
          onClose={() => {
            setRefundOpen(false);
            void refetch();
          }}
        />
      )}

      {/* Payment Info */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Payment Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-muted-foreground">Payment Intent ID</Label>
              <p className="font-mono text-sm text-foreground break-all">
                {payment.paymentIntent}
              </p>
            </div>
            <div>
              <Label className="text-muted-foreground">Amount</Label>
              <p className="text-2xl font-bold text-foreground">
                {formatCurrencyAmount(payment.amount, payment.currency)}
              </p>
            </div>
            <div>
              <Label className="text-muted-foreground">Status</Label>
              <div className="mt-1">
                <StatusBadge {...paymentStatusBadge(payment.paymentStatus)} />
              </div>
            </div>
            <div>
              <Label className="text-muted-foreground">Payment Gateway</Label>
              <p className="font-medium text-foreground">
                {gatewayLabel(payment.paymentGateway)}
              </p>
            </div>
            <div>
              <Label className="text-muted-foreground">Payment Type</Label>
              <p className="font-medium text-foreground">
                {payment.isMockPayment ? (
                  <span className="px-2 py-1 rounded text-sm font-medium bg-muted text-foreground">
                    MOCK PAYMENT
                  </span>
                ) : (
                  "Real Payment"
                )}
              </p>
            </div>
            <div>
              <Label className="text-muted-foreground">Created At</Label>
              <p className="text-foreground">
                {new Date(payment.createdAt).toLocaleString()}
              </p>
            </div>
            {payment.expiresAt && (
              <div>
                <Label className="text-muted-foreground">Expires At</Label>
                <p className="text-foreground">
                  {new Date(payment.expiresAt).toLocaleString()}
                </p>
              </div>
            )}
            {/* #1365 — the statutory B2C tax invoice. Absent for org-funded
                payments, which are invoiced to the organization instead. */}
            <div>
              <Label className="text-muted-foreground">Tax invoice</Label>
              {payment.consumerInvoice ? (
                <div className="mt-1 flex items-center gap-3">
                  <span className="font-mono text-sm text-foreground">
                    {payment.consumerInvoice.invoiceNumber}
                  </span>
                  <a
                    href={`/api/payments/${payment.id}/invoice/pdf`}
                    className="text-sm font-medium text-foreground underline underline-offset-4 hover:text-muted-foreground"
                  >
                    Download
                  </a>
                </div>
              ) : (
                <p className="text-muted-foreground">Not issued</p>
              )}
            </div>
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
                  <Label className="text-muted-foreground">
                    Appointment Type
                  </Label>
                  <p className="font-medium text-foreground">
                    {humanizeEnum(payment.appointment.appointmentType)}
                  </p>
                </div>
                <div>
                  <Label className="text-muted-foreground">
                    Appointment ID
                  </Label>
                  <p className="font-mono text-sm text-foreground break-all">
                    {payment.appointment.id}
                  </p>
                </div>
                <div>
                  <Label className="text-muted-foreground">User</Label>
                  <p className="text-foreground">
                    {payment.user?.name || "N/A"}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {payment.user?.email}
                  </p>
                </div>
              </>
            ) : (
              <p className="text-muted-foreground">
                No appointment associated yet
              </p>
            )}

            {payment.discountCode && (
              <div>
                <Label className="text-muted-foreground">Discount Code</Label>
                <p className="font-medium text-foreground">
                  {payment.discountCode.code}
                </p>
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
                  className="p-4 border border-border rounded-lg flex justify-between items-start gap-3"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-foreground">
                      {formatCurrencyAmount(
                        refund.amountPaise,
                        refund.currency,
                      )}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {refund.reason}
                    </p>
                    <p className="text-xs text-muted-foreground/70 mt-1">
                      {new Date(refund.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <StatusBadge {...refundStatusBadge(refund.status)} />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Disputes List */}
      {payment.disputes && payment.disputes.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Disputes</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {payment.disputes.map((dispute: PaymentDetailDispute) => (
                <Link
                  key={dispute.id}
                  href={`${basePath}/disputes/${dispute.id}`}
                  className="block p-4 border border-border rounded-lg hover:bg-muted transition-colors"
                >
                  <div className="flex justify-between items-start gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-foreground">
                        {formatCurrencyAmount(
                          dispute.amountPaise,
                          dispute.currency,
                        )}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {dispute.reason}
                      </p>
                      <p className="text-xs text-muted-foreground/70 mt-1">
                        {new Date(dispute.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <StatusBadge {...disputeStatus(dispute.status)} />
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
