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
 */

import { use } from "react";
import Link from "next/link";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Activity as ActivityIcon, Building2 } from "lucide-react";

import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface ActivityRow {
  id: string;
  organizationId: string;
  organizationName: string | null;
  organizationSlug: string | null;
  category: string;
  action: string;
  description: string;
  createdAt: string;
  actorName: string | null;
}

interface ActivityResponse {
  data: ActivityRow[];
  pagination: {
    hasMore: boolean;
    nextCursor: string | null;
    limit: number;
  };
}

async function fetchActivity(
  orgWorkspaceId: string,
  cursor: string | null,
): Promise<ActivityResponse> {
  const url = new URL(
    `/api/org-workspace/${orgWorkspaceId}/activity`,
    window.location.origin,
  );
  if (cursor) url.searchParams.set("cursor", cursor);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error("Failed to load activity");
  return res.json();
}

const CATEGORY_LABEL: Record<string, string> = {
  MEMBER: "Member",
  CONTRACT: "Contract",
  PROGRAM: "Program",
  WALLET: "Wallet",
  INVOICE: "Invoice",
  PAYOUT: "Payout",
  SETTINGS: "Settings",
  CONSENT: "Consent",
  CATALOG: "Catalog",
  SYSTEM: "System",
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export default function OrgWorkspaceActivityPage({
  params,
}: {
  params: Promise<{ orgWorkspaceId: string }>;
}) {
  const { orgWorkspaceId } = use(params);

  const query = useInfiniteQuery({
    queryKey: ["org-workspace-activity", orgWorkspaceId],
    queryFn: ({ pageParam }) =>
      fetchActivity(orgWorkspaceId, pageParam as string | null),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.pagination.hasMore ? lastPage.pagination.nextCursor : undefined,
  });

  const rows = query.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <>
      <DashboardHeader
        title="Activity"
        subtitle="Recent changes across all the organisations you operate"
      />
      <DashboardContent>
        {query.isLoading ? (
          <p className="text-sm text-zinc-500">Loading activity…</p>
        ) : rows.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center">
              <ActivityIcon className="w-10 h-10 mx-auto mb-3 text-zinc-400" />
              <p className="text-sm text-zinc-600">
                No activity yet. As your members invite, book, and bill,
                events will appear here.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <ul className="divide-y">
                {rows.map((r) => (
                  <li key={r.id} className="p-4 hover:bg-muted/30">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Badge variant="outline" className="font-mono">
                            {CATEGORY_LABEL[r.category] ?? r.category}
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
        )}

        {query.hasNextPage && (
          <div className="mt-4 flex justify-center">
            <Button
              variant="outline"
              onClick={() => query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
            >
              {query.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </DashboardContent>
    </>
  );
}
