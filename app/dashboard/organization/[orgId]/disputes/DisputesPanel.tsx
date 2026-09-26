"use client";

import { useQuery } from "@tanstack/react-query";

import { Stat, StatRow, StatSkeleton } from "@/components/dashboard/Stat";
import { Section } from "@/components/dashboard/Section";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { ErrorState } from "@/components/dashboard/ErrorState";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { humanizeEnum, type Tone } from "@/lib/ui/tone";
import { formatCurrencyAmount } from "@/utils/formatting";

interface DisputeItem {
  id: string;
  disputeId: string;
  amountPaise: number;
  currency: string;
  reason: string | null;
  status: string;
  dueBy: string | null;
  createdAt: string;
  updatedAt: string;
  payment: { id: string; billingAccountId: string | null };
}

async function fetchDisputes(orgId: string): Promise<{ data: DisputeItem[] }> {
  const res = await fetch(`/api/organizations/${orgId}/disputes`);
  if (!res.ok) throw new Error("Failed to load disputes");
  return res.json();
}

// Mirrors prisma `enum DisputeStatus`. "Open" rolls up everything still
// needing action or under review; LOST/CHARGE_REFUNDED were settled against
// the org (its wallet bore the chargeback).
const STATUS: Record<
  string,
  { label: string; tone: Tone; open: boolean; lost: boolean }
> = {
  WARNING_NEEDS_RESPONSE: {
    label: "Needs response",
    tone: "warning",
    open: true,
    lost: false,
  },
  WARNING_UNDER_REVIEW: {
    label: "Under review",
    tone: "info",
    open: true,
    lost: false,
  },
  WARNING_CLOSED: {
    label: "Closed",
    tone: "neutral",
    open: false,
    lost: false,
  },
  NEEDS_RESPONSE: {
    label: "Needs response",
    tone: "warning",
    open: true,
    lost: false,
  },
  UNDER_REVIEW: {
    label: "Under review",
    tone: "info",
    open: true,
    lost: false,
  },
  CHARGE_REFUNDED: {
    label: "Charge refunded",
    tone: "critical",
    open: false,
    lost: true,
  },
  WON: { label: "Won", tone: "success", open: false, lost: false },
  LOST: { label: "Lost", tone: "critical", open: false, lost: true },
  // Ended without a verdict; the wallet bore nothing beyond any refund.
  CLOSED: { label: "Closed", tone: "neutral", open: false, lost: false },
};

const columns: ResponsiveColumn<DisputeItem>[] = [
  {
    key: "raised",
    header: "Raised",
    primary: true,
    cell: (d) => new Date(d.createdAt).toLocaleDateString("en-IN"),
  },
  {
    key: "amount",
    header: "Amount",
    className: "tabular-nums",
    cell: (d) => formatCurrencyAmount(d.amountPaise, d.currency),
  },
  { key: "reason", header: "Reason", cell: (d) => d.reason ?? "—" },
  {
    key: "due",
    header: "Due by",
    cell: (d) =>
      d.dueBy ? new Date(d.dueBy).toLocaleDateString("en-IN") : "—",
  },
  {
    key: "status",
    header: "Status",
    cell: (d) => {
      const s = STATUS[d.status];
      return (
        <StatusBadge
          label={s?.label ?? humanizeEnum(d.status)}
          tone={s?.tone ?? "neutral"}
        />
      );
    },
  },
];

/** Chargebacks on org-funded bookings — a Billing tab since #1527 Q7. */
export function DisputesPanel({ orgId }: Readonly<{ orgId: string }>) {
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ["org-disputes", orgId],
    queryFn: () => fetchDisputes(orgId),
  });

  if (isPending) {
    return (
      <StatRow columns={3}>
        <StatSkeleton />
        <StatSkeleton />
        <StatSkeleton />
      </StatRow>
    );
  }
  if (isError) {
    // A failed read is not a clean record.
    return (
      <ErrorState
        title="Couldn't load disputes"
        description="This is a loading problem, not a clean record."
        onRetry={() => void refetch()}
      />
    );
  }

  const disputes = data.data;
  const openCount = disputes.filter((d) => STATUS[d.status]?.open).length;
  const lostAmount = disputes
    .filter((d) => STATUS[d.status]?.lost)
    .reduce((sum, d) => sum + d.amountPaise, 0);

  return (
    <>
      <StatRow columns={3}>
        <Stat
          label="Open disputes"
          value={openCount}
          tone={openCount > 0 ? "warning" : "neutral"}
        />
        <Stat
          label="Lost to chargebacks"
          value={formatCurrencyAmount(lostAmount, "INR")}
          hint="Borne by the organization"
          tone={lostAmount > 0 ? "critical" : "neutral"}
        />
        <Stat label="Total disputes" value={disputes.length} />
      </StatRow>
      <Section title="Dispute history">
        <ResponsiveTable<DisputeItem>
          columns={columns}
          rows={disputes}
          getRowId={(d) => d.id}
          empty="No disputes have been raised against this organization."
        />
      </Section>
    </>
  );
}
