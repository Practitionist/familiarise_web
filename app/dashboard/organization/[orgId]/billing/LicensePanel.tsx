"use client";

import { EmptyState } from "@/components/dashboard/EmptyState";
import { KeyValueList, Section } from "@/components/dashboard/Section";
import { formatCurrencyAmount } from "@/utils/formatting";
import { formatInvoiceDate, invoiceDateLabel } from "@/lib/time/invoice-date";

import type { BillingSummary } from "./billing-api";

const CYCLE_LABEL = {
  MONTHLY: "month",
  QUARTERLY: "quarter",
  ANNUAL: "year",
} as const;

/**
 * Billing › License: the LICENSE commercial terms captured at contract
 * creation (T5 / #756 GS-1). Bookings under a license consume no per-session
 * charge.
 */
export function LicensePanel({
  summary,
}: Readonly<{ summary: BillingSummary | undefined }>) {
  const contract = summary?.licenseContract;
  const sub = contract?.subscription;
  if (!contract || !sub) {
    return (
      <EmptyState
        title="No license fee recorded"
        description="The annual license covers all usage. Its fee and renewal dates appear here once they are recorded on the contract."
      />
    );
  }
  return (
    <Section
      title="Annual license"
      description="Prepaid contract. Bookings under this organization consume no per-session charge while it runs."
      variant="card"
    >
      <KeyValueList
        items={[
          {
            label: "Fee",
            // FDE: a fee-less license is incomplete, not free — never ₹0.00.
            value:
              sub.flatFeePaise === null
                ? "Not recorded"
                : `${formatCurrencyAmount(sub.flatFeePaise, "INR")} per ${CYCLE_LABEL[sub.cycle]}`,
            hint:
              sub.flatFeePaise === null
                ? "Required before renewal."
                : undefined,
          },
          // The cycle becomes the renewal invoice's billing period, so it reads as invoice dates do.
          {
            label: invoiceDateLabel("Current cycle"),
            value: `${formatInvoiceDate(sub.currentCycleStart)} – ${formatInvoiceDate(sub.currentCycleEnd)}`,
          },
          {
            label: invoiceDateLabel("Next renewal"),
            value: formatInvoiceDate(sub.nextInvoiceDate),
          },
          {
            label: "Auto-renew",
            value: contract.autoRenew ? "On" : "Off",
          },
        ]}
      />
    </Section>
  );
}
