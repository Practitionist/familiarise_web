"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
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
  payment: { id: string } | null;
  relationship: "BUYER" | "HOST" | "BUYER_AND_HOST";
}

interface DisputesResponse {
  data: DisputeItem[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
  stats: {
    totalCount: number;
    openCount: number;
    lostAmounts: { currency: string; amountPaise: number }[];
  };
}

async function fetchDisputes(
  orgId: string,
  page: number,
): Promise<DisputesResponse> {
  const res = await fetch(
    `/api/organizations/${orgId}/disputes?limit=25&offset=${(page - 1) * 25}`,
  );
  if (!res.ok) throw new Error("Failed to load disputes");
  return res.json();
}

const STATUS: Record<string, { label: string; tone: Tone }> = {
  WARNING_NEEDS_RESPONSE: {
    label: "Needs response",
    tone: "warning",
  },
  WARNING_UNDER_REVIEW: {
    label: "Under review",
    tone: "info",
  },
  WARNING_CLOSED: {
    label: "Closed",
    tone: "neutral",
  },
  NEEDS_RESPONSE: {
    label: "Needs response",
    tone: "warning",
  },
  UNDER_REVIEW: {
    label: "Under review",
    tone: "info",
  },
  CHARGE_REFUNDED: {
    label: "Charge refunded",
    tone: "critical",
  },
  WON: { label: "Won", tone: "success" },
  LOST: { label: "Lost", tone: "critical" },
  CLOSED: { label: "Closed", tone: "neutral" },
};
const RELATIONSHIP_LABELS: Record<DisputeItem["relationship"], string> = {
  BUYER_AND_HOST: "Buyer and host",
  BUYER: "Buyer",
  HOST: "Host",
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
  {
    key: "relationship",
    header: "Organization role",
    cell: (d) => RELATIONSHIP_LABELS[d.relationship],
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

/** Chargebacks on the organization’s buyer and host activity. */
export function DisputesPanel({ orgId }: Readonly<{ orgId: string }>) {
  const [page, setPage] = useState(1);
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ["org-disputes", orgId, page],
    queryFn: () => fetchDisputes(orgId, page),
  });

  if (isPending) {
    return (
      <StatRow columns={3} stackOnPhone>
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
  const { openCount, totalCount, lostAmounts } = data.stats;
  const lostAmount =
    lostAmounts
      .map((row) => formatCurrencyAmount(row.amountPaise, row.currency))
      .join(" · ") || formatCurrencyAmount(0, "INR");
  const totalPages = Math.max(
    1,
    Math.ceil(data.pagination.total / data.pagination.limit),
  );

  return (
    <>
      <StatRow columns={3} stackOnPhone>
        <Stat
          label="Open disputes"
          value={openCount}
          tone={openCount > 0 ? "warning" : "neutral"}
        />
        <Stat
          label="Lost or refunded dispute value"
          value={lostAmount}
          hint="Disputed value; actual recovery depends on funding and earnings"
          tone={
            lostAmounts.some((row) => row.amountPaise > 0)
              ? "critical"
              : "neutral"
          }
        />
        <Stat label="Total disputes" value={totalCount} />
      </StatRow>
      <Section title="Dispute history">
        <p className="mb-4 text-sm text-zinc-500">
          Buyer funding and host earnings can both be affected. A dispute’s
          amount is not the organization’s final liability. Funding details are
          visible only to the buyer organization.
        </p>
        <ResponsiveTable<DisputeItem>
          columns={columns}
          rows={disputes}
          getRowId={(d) => d.id}
          empty="No disputes have been raised against this organization."
        />
      </Section>
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </Button>
          <span className="text-sm text-zinc-500">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={!data.pagination.hasMore}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </>
  );
}
