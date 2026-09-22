"use client";

import { useQuery } from "@tanstack/react-query";
import {
  fetchPendingPayments,
  PendingPaymentsWidget,
} from "../home/PendingPaymentsWidget";

/**
 * #1675 X4 — the "Needs you" band above the payment history: the approved
 * bookings still waiting on a payment and the pay links that lapsed. It reads
 * the Home widget's `pending-payments` query (one cache entry for both pages)
 * and mounts the widget itself for the rows — the countdown, the Pay button
 * and the cancel dialogs live there and are not forked here. Absent when
 * there is nothing to act on.
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
  if (pending + lapsed === 0) return null;

  return (
    <section aria-labelledby="needs-you-heading" className="mb-6">
      <h2
        id="needs-you-heading"
        className="mb-3 text-sm font-semibold text-foreground"
      >
        Needs you
      </h2>
      <PendingPaymentsWidget consulteeId={consulteeId} />
    </section>
  );
}
