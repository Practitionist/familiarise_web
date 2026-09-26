"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { formatCurrencyAmount } from "@/utils/formatting";
import {
  fetchPendingPayments,
  PendingPaymentsWidget,
} from "../home/PendingPaymentsWidget";

/**
 * #1675 X4 / #1527 — the Payments › Needs you tab: the approved bookings still
 * waiting on a payment, the pay links that lapsed, and refunds that failed.
 * It reads the Home inbox's `pending-payments` query (one cache entry for
 * both pages) and mounts the widget itself for the payable rows — the
 * countdown, the Pay button and the cancel dialogs live there and are not
 * forked here. "Nothing needs you" when the queue is clear.
 */
export function NeedsYouBand({
  consulteeId,
}: Readonly<{ consulteeId: string }>) {
  const { data } = useQuery({
    queryKey: ["pending-payments", consulteeId],
    queryFn: () => fetchPendingPayments(consulteeId),
    refetchOnWindowFocus: true,
    staleTime: 30 * 1000,
  });
  const pending = data?.pendingPayments.length ?? 0;
  const lapsed = data?.lapsedPayLinks.length ?? 0;
  const failedRefunds = data?.failedRefunds ?? [];

  if (data && pending + lapsed + failedRefunds.length === 0) {
    return (
      <EmptyState
        icon={CheckCircle2}
        title="Nothing needs you"
        description="Charges waiting on you and refunds that need a follow-up show up here."
      />
    );
  }

  return (
    <section aria-label="Needs you" className="space-y-3">
      {failedRefunds.length > 0 && (
        <ul className="space-y-2">
          {failedRefunds.map((refund) => (
            <li
              key={refund.paymentId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-4 py-3 text-sm"
            >
              <span className="text-foreground">
                We couldn&apos;t return{" "}
                {formatCurrencyAmount(refund.amountPaise, refund.currency)} to
                your payment method.
              </span>
              <Link
                href={`/dashboard/consultee/${consulteeId}/payments/${refund.paymentId}`}
                className="font-medium text-foreground underline underline-offset-4"
              >
                View charge
              </Link>
            </li>
          ))}
        </ul>
      )}
      {pending + lapsed > 0 && (
        <PendingPaymentsWidget consulteeId={consulteeId} />
      )}
    </section>
  );
}
