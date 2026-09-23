"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";

import { EmptyState } from "@/components/dashboard/DataCard";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/auth-client";
import { EARNINGS_FETCH_CAP } from "@/lib/dashboard/earnings-state";
import {
  EarningsBuckets,
  EarningsSkeleton,
  type EarningsResponse,
} from "./EarningsBuckets";

/**
 * The Summary panel of the Earnings page: the query container for
 * `EarningsBuckets`. One read, no server-side status filter — the segmented
 * list buckets rows client-side through `lib/dashboard/earnings-state.ts`, so
 * the tiles and the badges can never disagree.
 */
export function EarningsSummaryPanel({
  consultantId,
}: Readonly<{ consultantId: string }>) {
  const { data: session, isPending: isSessionPending } = useSession();
  // The route is session-scoped while the server seed is keyed by the URL's
  // consultantId (see AnalyticsPageClient): a privileged viewer's refetch would
  // fetch THEIR earnings under this consultant's key, so refetching is gated.
  const isOwnDashboard =
    (session?.user as { consultantProfileId?: string } | undefined)
      ?.consultantProfileId === consultantId;

  const { data, isLoading, isPlaceholderData, error, refetch } =
    useQuery<EarningsResponse>({
      queryKey: ["consultant-earnings", consultantId],
      queryFn: async () => {
        const res = await fetch(
          `/api/consultant/earnings?limit=${EARNINGS_FETCH_CAP}`,
        );
        if (!res.ok) throw new Error("Failed to fetch earnings");
        return res.json();
      },
      staleTime: 30_000,
      // The key carries no filter today; kept so a future key change cannot
      // regress to the blank-page-on-switch bug (#346) this file once had.
      placeholderData: keepPreviousData,
      enabled: isOwnDashboard,
    });

  if (isLoading && !data) return <EarningsSkeleton />;
  // The query is disabled until the session names the owner, so `isLoading`
  // is false while the session is pending; without this the panel is blank
  // whenever the server seed failed.
  if (isSessionPending && !data) return <EarningsSkeleton />;

  if (error && !data) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Couldn't load your earnings"
        description={
          error instanceof Error ? error.message : "Please try again later."
        }
        action={
          <Button
            variant="outline"
            onClick={() => {
              // refetch() bypasses `enabled`; re-apply the owner gate.
              if (isOwnDashboard) void refetch();
            }}
          >
            Retry
          </Button>
        }
      />
    );
  }
  // Seed failed and the viewer is not the owner (ADMIN/STAFF inspecting), so
  // no client refetch will ever fill this in; say so instead of a blank panel.
  if (!data) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Couldn't load these earnings"
        description="Refresh the page to try again."
      />
    );
  }

  return (
    <EarningsBuckets
      consultantId={consultantId}
      data={data}
      isStale={isPlaceholderData}
    />
  );
}
