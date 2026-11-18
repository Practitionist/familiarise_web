"use client";

/**
 * Cross-org audit feed. Operators with 3+ orgs need one place to see
 * "what changed across my portfolio in the last week" without clicking
 * into each org's /audit tab. Read-only timeline; per-org audit lives
 * at /dashboard/organization/[orgId]/audit and supports rich filters
 * for compliance review.
 *
 * Pagination: cursor-based, 50/page. The same Load-more pattern used
 * elsewhere in the codebase keeps the bundle lean (no infinite-scroll
 * libraries).
 *
 * Client half of the split page. The server `page.tsx` SSR-prefetches the
 * FIRST page (cursor=null) under ["org-workspace-activity", orgWorkspaceId]
 * via prefetchInfiniteQuery; the useInfiniteQuery below hydrates from that
 * cache and drives Load-more client-side.
 */

import { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Activity as ActivityIcon, Building2 } from "lucide-react";

import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { FilterBar } from "@/components/dashboard/FilterBar";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/dashboard/DataCard";
import { timeAgo } from "@/lib/time/time-ago";
import type { OrgAuditCategory } from "@prisma/client";
import { ORG_AUDIT_CATEGORY_LABEL } from "@/lib/labels/org-labels";

interface ActivityRow {
  id: string;
  organizationId: string;
  organizationName: string | null;
  organizationSlug: string | null;
  category: OrgAuditCategory;
  action: string;
  description: string;
  createdAt: string;
  actorName: string | null;
}

interface ActivityOrgOption {
  id: string;
  name: string;
}

interface ActivityResponse {
  data: ActivityRow[];
  organizations?: ActivityOrgOption[];
  pagination: {
    hasMore: boolean;
    nextCursor: string | null;
    limit: number;
  };
}

/** A 401/403 means access was withdrawn: the loaded feed must not stay on screen. */
class ActivityRefusedError extends Error {}

async function fetchActivity(
  orgWorkspaceId: string,
  cursor: string | null,
  orgFilter: string,
  categoryFilter: string,
): Promise<ActivityResponse> {
  const url = new URL(
    `/api/org-workspace/${orgWorkspaceId}/activity`,
    window.location.origin,
  );
  if (cursor) url.searchParams.set("cursor", cursor);
  if (orgFilter !== "all") url.searchParams.set("organizationId", orgFilter);
  if (categoryFilter !== "all")
    url.searchParams.set("category", categoryFilter);
  const res = await fetch(url.toString());
  if (res.status === 401 || res.status === 403) {
    throw new ActivityRefusedError("Activity is not available");
  }
  if (!res.ok) throw new Error("Failed to load activity");
  return res.json();
}

export function ActivityPageClient({
  orgWorkspaceId,
}: Readonly<{
  orgWorkspaceId: string;
}>) {
  const [orgFilter, setOrgFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");

  const query = useInfiniteQuery({
    queryKey: [
      "org-workspace-activity",
      orgWorkspaceId,
      orgFilter,
      categoryFilter,
    ],
    queryFn: ({ pageParam }) =>
      fetchActivity(
        orgWorkspaceId,
        pageParam as string | null,
        orgFilter,
        categoryFilter,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.pagination.hasMore ? lastPage.pagination.nextCursor : undefined,
  });

  const rows = useMemo(
    () => query.data?.pages.flatMap((p) => p.data) ?? [],
    [query.data],
  );

  const orgOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const org of query.data?.pages[0]?.organizations ?? []) {
      seen.set(org.id, org.name);
    }
    for (const r of rows) {
      if (r.organizationId && !seen.has(r.organizationId)) {
        seen.set(r.organizationId, r.organizationName ?? r.organizationId);
      }
    }
    return [
      { value: "all", label: "All organizations" },
      ...Array.from(seen.entries()).map(([value, label]) => ({ value, label })),
    ];
  }, [query.data, rows]);

  const categoryOptions = useMemo(
    () => [
      { value: "all", label: "All categories" },
      ...Object.entries(ORG_AUDIT_CATEGORY_LABEL).map(([value, label]) => ({
        value,
        label,
      })),
    ],
    [],
  );

  const filteredRows = useMemo(
    () =>
      rows.filter(
        (r) =>
          (orgFilter === "all" || r.organizationId === orgFilter) &&
          (categoryFilter === "all" || r.category === categoryFilter),
      ),
    [rows, orgFilter, categoryFilter],
  );

  const hasActiveFilters = orgFilter !== "all" || categoryFilter !== "all";
  const refused = query.error instanceof ActivityRefusedError;

  const renderFeedBody = () => {
    if (query.isLoading) {
      return (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y">
              {[1, 2, 3, 4, 5].map((i) => (
                <li key={i} className="p-4">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="mt-2 h-4 w-3/4" />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      );
    }

    if (query.isError && (!query.data || refused)) {
      return (
        <Card>
          <CardContent className="py-10">
            <EmptyState
              icon={ActivityIcon}
              title="Couldn't load activity"
              description="We hit an error fetching your cross-org activity feed."
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => query.refetch()}
                >
                  Retry
                </Button>
              }
            />
          </CardContent>
        </Card>
      );
    }

    if (filteredRows.length === 0) {
      return (
        <Card>
          <CardContent className="py-10 text-center">
            <ActivityIcon className="w-10 h-10 mx-auto mb-3 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {hasActiveFilters
                ? "No activity matches the selected filters."
                : "No activity yet. As your members invite, book, and bill, events will appear here."}
            </p>
          </CardContent>
        </Card>
      );
    }

    return (
      <Card>
        <CardContent className="p-0">
          <ul className="divide-y">
            {filteredRows.map((r) => (
              <li key={r.id} className="p-4 hover:bg-muted/30">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="outline" className="font-mono">
                        {ORG_AUDIT_CATEGORY_LABEL[r.category]}
                      </Badge>
                      {r.organizationName && (
                        <Link
                          href={`/dashboard/organization/${r.organizationId}/audit`}
                          className="inline-flex items-center gap-1 hover:underline"
                        >
                          <Building2 className="w-3 h-3" />
                          {r.organizationName}
                        </Link>
                      )}
                      <span>· {timeAgo(r.createdAt)}</span>
                    </div>
                    <p className="text-sm mt-1">{r.description}</p>
                    {r.actorName && (
                      <p className="text-xs text-muted-foreground mt-1">
                        by {r.actorName}
                      </p>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    );
  };

  return (
    <>
      <DashboardHeader
        title="Activity"
        subtitle="Recent changes across all the organisations you operate"
      />
      <DashboardContent>
        <FilterBar
          selects={[
            {
              key: "organization",
              label: "Organization",
              value: orgFilter,
              options: orgOptions,
              onChange: setOrgFilter,
            },
            {
              key: "category",
              label: "Category",
              value: categoryFilter,
              options: categoryOptions,
              onChange: setCategoryFilter,
            },
          ]}
          canClear={hasActiveFilters}
          onClear={() => {
            setOrgFilter("all");
            setCategoryFilter("all");
          }}
        />
        {query.isRefetchError && !refused && (
          <p
            role="alert"
            className="mb-3 flex flex-wrap items-center gap-2 text-sm text-amber-700"
          >
            Couldn&apos;t refresh activity; showing the last loaded feed.
            <Button
              size="sm"
              variant="outline"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              Retry
            </Button>
          </p>
        )}
        {renderFeedBody()}

        {query.hasNextPage && !refused && (
          <div className="mt-4 flex flex-col items-center gap-2">
            {query.isFetchNextPageError && (
              <p role="alert" className="text-sm text-amber-700">
                Couldn&apos;t load more activity.
              </p>
            )}
            <Button
              variant="outline"
              onClick={() => void query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
            >
              {query.isFetchingNextPage
                ? "Loading…"
                : query.isFetchNextPageError
                  ? "Retry"
                  : "Load more"}
            </Button>
          </div>
        )}
      </DashboardContent>
    </>
  );
}
