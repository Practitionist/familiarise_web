"use client";

import Link from "next/link";
import { useQueries } from "@tanstack/react-query";

import { Stat, StatRow, StatSkeleton } from "@/components/dashboard/Stat";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { Button } from "@/components/ui/button";

const QUEUE = [
  { status: "OPEN", label: "Open", tone: "caution" as const },
  { status: "IN_PROGRESS", label: "In progress", tone: "info" as const },
  {
    status: "ESCALATED",
    label: "With platform team",
    tone: "caution" as const,
  },
];

async function countThreads(orgId: string, status: string): Promise<number> {
  const params = new URLSearchParams({ status, pageSize: "1" });
  const res = await fetch(
    `/api/organizations/${orgId}/support-threads?${params}`,
  );
  if (!res.ok) throw new Error("Failed to load support threads");
  const json = (await res.json()) as { pagination: { total: number } };
  return json.pagination.total;
}

/**
 * SUPPORT's overview (#1527 §7.3): the member-support queue by status, not
 * the consumer card it used to get. Counts only — conversations stay
 * metadata-level (ADR 20).
 */
export function SupportHome({ orgId }: Readonly<{ orgId: string }>) {
  const base = `/dashboard/organization/${orgId}`;
  const counts = useQueries({
    queries: QUEUE.map((q) => ({
      queryKey: ["org-support-threads-count", orgId, q.status],
      queryFn: () => countThreads(orgId, q.status),
    })),
  });

  const failed = counts.some((c) => c.isError);
  const pending = counts.some((c) => c.isPending);

  let figures: React.ReactNode;
  if (failed) {
    figures = (
      <ErrorState
        title="Couldn't load the support queue"
        onRetry={() => counts.forEach((c) => void c.refetch())}
      />
    );
  } else if (pending) {
    figures = (
      <StatRow columns={3}>
        <StatSkeleton />
        <StatSkeleton />
        <StatSkeleton />
      </StatRow>
    );
  } else {
    figures = (
      <StatRow columns={3}>
        {QUEUE.map((q, i) => (
          <Stat
            key={q.status}
            label={q.label}
            value={counts[i].data ?? 0}
            tone={(counts[i].data ?? 0) > 0 ? q.tone : "neutral"}
            href={`${base}/support`}
          />
        ))}
      </StatRow>
    );
  }

  return (
    <>
      {figures}
      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm">
          <Link href={`${base}/support`}>Open support queue</Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href={`${base}/appointments?tab=everyone`}>
            Everyone&apos;s appointments
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href={`${base}/documents`}>Documents</Link>
        </Button>
      </div>
    </>
  );
}
