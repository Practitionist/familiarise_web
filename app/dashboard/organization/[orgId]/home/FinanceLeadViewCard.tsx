"use client";

/**
 * The BILLING_ADMIN landing on /home (#1527 §7.3).
 *
 * BILLING_ADMIN is finance-only and operator-blind, so the analytics
 * aggregate (operations.read) always 403'd here. The overview now reads the
 * two finance endpoints the role does hold: GET …/billing (billing.read,
 * sponsor orgs) and GET …/payouts (payouts.read, host orgs). Query keys match
 * the Billing and Payouts pages so a jump there is instant.
 */

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { Stat, StatRow, StatSkeleton } from "@/components/dashboard/Stat";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { Section } from "@/components/dashboard/Section";
import { Button } from "@/components/ui/button";
import { BillingBlockBanner } from "@/components/billing/BillingBlockBanner";
import { formatCurrencyAmount } from "@/utils/formatting";

import { fetchBilling } from "../billing/billing-api";

interface PayoutStats {
  stats: {
    totalPaidPaise: number;
    pendingPaise: number;
    counts: Record<string, number>;
  };
}

async function fetchPayoutStats(orgId: string): Promise<PayoutStats> {
  const res = await fetch(`/api/organizations/${orgId}/payouts?limit=1`);
  if (!res.ok) throw new Error("Failed to load payouts");
  return res.json();
}

function SponsorFinance({ orgId }: Readonly<{ orgId: string }>) {
  const base = `/dashboard/organization/${orgId}`;
  const billing = useQuery({
    queryKey: ["org-billing", orgId],
    queryFn: () => fetchBilling(orgId),
  });
  if (billing.isPending) {
    return (
      <StatRow columns={3}>
        <StatSkeleton />
        <StatSkeleton />
        <StatSkeleton />
      </StatRow>
    );
  }
  if (billing.isError) {
    return (
      <ErrorState
        title="Couldn't load the billing summary"
        description="This is a loading problem, not a zero balance."
        onRetry={() => void billing.refetch()}
      />
    );
  }
  const b = billing.data;
  return (
    <>
      <BillingBlockBanner
        walletFrozen={b.walletFrozen}
        walletFrozenReason={b.walletFrozenReason}
        dunningSuspended={b.dunningSuspended}
        supportHref="/dashboard/go/auto/support"
      />
      <StatRow columns={3}>
        <Stat
          label="Outstanding"
          value={formatCurrencyAmount(b.outstanding.amount, "INR")}
          hint={`${b.outstanding.invoiceCount} unpaid invoices`}
          tone={b.outstanding.invoiceCount > 0 ? "warning" : "neutral"}
          href={`${base}/billing`}
        />
        <Stat
          label="This month"
          value={formatCurrencyAmount(b.monthToDate.gross, "INR")}
          hint={`${b.monthToDate.paymentCount} bookings`}
        />
        {b.pendingCharges && (
          <Stat
            label="Not yet invoiced"
            value={formatCurrencyAmount(b.pendingCharges.amount, "INR")}
            hint={`${b.pendingCharges.paymentCount} bookings`}
            href={`${base}/billing?tab=accrued-usage`}
          />
        )}
      </StatRow>
    </>
  );
}

function HostFinance({ orgId }: Readonly<{ orgId: string }>) {
  const payouts = useQuery({
    queryKey: ["org-payout-stats", orgId],
    queryFn: () => fetchPayoutStats(orgId),
  });
  const href = `/dashboard/organization/${orgId}/payouts`;
  if (payouts.isPending) {
    return (
      <StatRow columns={3}>
        <StatSkeleton />
        <StatSkeleton />
      </StatRow>
    );
  }
  if (payouts.isError) {
    return (
      <ErrorState
        title="Couldn't load payouts"
        onRetry={() => void payouts.refetch()}
      />
    );
  }
  const { stats } = payouts.data;
  return (
    <StatRow columns={3}>
      <Stat
        label="Payouts in flight"
        value={formatCurrencyAmount(stats.pendingPaise, "INR")}
        tone={stats.pendingPaise > 0 ? "caution" : "neutral"}
        href={href}
      />
      <Stat
        label="Paid out"
        value={formatCurrencyAmount(stats.totalPaidPaise, "INR")}
        hint={`${stats.counts.COMPLETED ?? 0} payouts`}
        href={href}
      />
    </StatRow>
  );
}

export function FinanceLeadViewCard({
  orgId,
  canSponsor,
  canHost,
}: Readonly<{ orgId: string; canSponsor: boolean; canHost: boolean }>) {
  const base = `/dashboard/organization/${orgId}`;
  const links = [
    { label: "Invoices", href: `${base}/billing`, show: canSponsor },
    { label: "Payouts", href: `${base}/payouts`, show: canHost },
    {
      label: "Webhooks",
      href: `${base}/settings?tab=webhooks`,
      show: true,
    },
    {
      label: "Data exports",
      href: `${base}/settings?tab=data-exports`,
      show: true,
    },
  ].filter((l) => l.show);

  return (
    <>
      {canSponsor && (
        <Section title="Billing">
          <SponsorFinance orgId={orgId} />
        </Section>
      )}
      {canHost && (
        <Section title="Payouts">
          <HostFinance orgId={orgId} />
        </Section>
      )}
      <div className="flex flex-wrap gap-2">
        {links.map((l) => (
          <Button key={l.label} asChild variant="outline" size="sm">
            <Link href={l.href}>{l.label}</Link>
          </Button>
        ))}
      </div>
    </>
  );
}
