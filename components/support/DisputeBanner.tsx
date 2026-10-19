"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { DISPUTE_STATUS_LABEL } from "@/lib/support/disputes/protocol";
import { formatCurrencyAmount } from "@/utils/formatting";

/**
 * The buyer's dispute banner.
 *
 * It answers the only two questions a buyer has about a claim they have
 * already raised: where is it, and whose move is it. It sits at the top of
 * the payment page, so the claim is visible from the order rather than
 * buried in a support list.
 */
export interface DisputeBannerData {
  id: string;
  referenceNumber: string;
  status: string;
  reason: string;
  round: number;
  amountPaise: number;
  /** A `Date` on the server, an ISO string once it crosses to the client. */
  respondentDueAt: Date | string | null;
  escalatedAt: Date | string | null;
  createdAt: Date | string;
}

const TONE_BY_STATUS: Record<string, "warning" | "info" | "success" | "neutral"> =
  {
    OPEN: "warning",
    RESPONDED: "info",
    ESCALATED: "info",
    UNDER_REVIEW: "info",
    RESOLVED: "success",
    WITHDRAWN: "neutral",
    CLOSED: "neutral",
  };

export function DisputeBanner({
  dispute,
  disputeHref,
}: Readonly<{
  dispute: DisputeBannerData;
  disputeHref: string;
}>) {
  const label = DISPUTE_STATUS_LABEL[dispute.status as keyof typeof DISPUTE_STATUS_LABEL];
  return (
    <section
      aria-label="Dispute"
      className="rounded-lg border border-warning/40 bg-warning/5 p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">
            You have an open dispute on this payment
          </p>
          <p className="text-sm text-muted-foreground">
            {label ?? dispute.status} · reference{" "}
            <span className="tabular-nums">{dispute.referenceNumber}</span> ·{" "}
            {formatCurrencyAmount(dispute.amountPaise, "INR")}
          </p>
        </div>
        <StatusBadge
          label={label ?? dispute.status}
          tone={TONE_BY_STATUS[dispute.status] ?? "neutral"}
          size="sm"
        />
      </div>
      <div className="mt-3">
        <Button asChild size="sm" variant="outline">
          <Link href={disputeHref}>View dispute</Link>
        </Button>
      </div>
    </section>
  );
}
