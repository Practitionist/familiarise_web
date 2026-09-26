"use client";

import { useState } from "react";
import { displayedScore } from "@/lib/reviews-display";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { PanelHeader } from "@/components/dashboard/PageScaffold";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { useRequireOrgAccess } from "../useOrgRole";
import type { MemberStatus } from "@prisma/client";

// ---------------------------------------------------------------------------
// Types — rows come from GET /api/organizations/[orgId]/members?role=EXPERT
// ---------------------------------------------------------------------------

interface ExpertRow {
  id: string;
  status: MemberStatus;
  payoutRecipient: "SELF" | "ORGANIZATION";
  departmentLabel: string | null;
  createdAt: string;
  user: { id: string; name: string | null; email: string };
  consultantProfile: {
    id: string;
    headline: string | null;
    publishedRatingOneToOne: number | null;
    publishedRatingGroup: number | null;
    isVerified: boolean;
  } | null;
}

async function fetchExperts(
  orgId: string,
  page: number,
  status?: MemberStatus,
): Promise<{ data: ExpertRow[]; total: number; page: number; perPage: number }> {
  const params = new URLSearchParams({
    role: "EXPERT",
    page: String(page),
    perPage: "20",
  });
  if (status) params.set("status", status);
  const res = await fetch(`/api/organizations/${orgId}/members?${params}`);
  if (!res.ok) throw new Error("Failed to load experts");
  const json = await res.json();
  return {
    data: json.data ?? [],
    total: json.meta?.total ?? 0,
    page: json.meta?.page ?? page,
    perPage: json.meta?.perPage ?? 20,
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

// The LEARNER<->EXPERT disjoint-roles rule means EXPERT Memberships are
// always ACTIVE on creation (they come from invites or direct admin
// adds that immediately grant the role). There is no PENDING application
// queue for experts anymore — this page is purely a read view of the
// active roster. If we bring back an in-org apply flow later, rebuild
// it around a dedicated model, not a MemberStatus.PENDING.
export function ExpertsPanel({ orgId }: { orgId: string }) {
  const { allowed } = useRequireOrgAccess(orgId, {
    permission: "experts.read",
    canHost: true,
  });
  // Server-paginated (was a fixed perPage=100 with no pager).
  const [page, setPage] = useState(1);

  const active = useQuery({
    queryKey: ["org-experts", orgId, "ACTIVE", page],
    queryFn: () => fetchExperts(orgId, page, "ACTIVE"),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  const totalPages = Math.max(
    1,
    Math.ceil((active.data?.total ?? 0) / (active.data?.perPage ?? 20)),
  );

  if (!allowed) return null;

  const activeRows = active.data?.data ?? [];

  const columns: ResponsiveColumn<ExpertRow>[] = [
    {
      key: "expert",
      header: "Expert",
      primary: true,
      cell: (row) => (
        <div className="flex flex-col">
          <span className="font-medium text-foreground">
            {row.user.name ?? "—"}
          </span>
          <span className="text-xs text-muted-foreground">
            {row.user.email}
          </span>
        </div>
      ),
    },
    {
      key: "headline",
      header: "Headline",
      className: "text-sm text-muted-foreground max-w-xs truncate",
      cell: (row) => row.consultantProfile?.headline ?? "—",
    },
    {
      key: "rating",
      header: "Rating",
      // Published score or nothing: the raw mean read 5.0 off one review.
      cell: (row) => {
        if (!row.consultantProfile) return "—";
        const shown = displayedScore(row.consultantProfile);
        return shown.score === null ? "—" : shown.score.toFixed(1);
      },
    },
    {
      key: "payout",
      header: "Payout",
      cell: (row) => (
        <Badge
          variant={
            row.payoutRecipient === "ORGANIZATION" ? "secondary" : "outline"
          }
        >
          {row.payoutRecipient === "ORGANIZATION" ? "Org (internal)" : "Self"}
        </Badge>
      ),
    },
    {
      key: "verified",
      header: "Verified",
      cell: (row) => (
        <Badge
          variant={row.consultantProfile?.isVerified ? "default" : "outline"}
        >
          {row.consultantProfile?.isVerified ? "Yes" : "No"}
        </Badge>
      ),
    },
  ];

  return (
    <>
      <PanelHeader description="Experts providing services under this organization" />
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {active.isLoading
                ? "Loading…"
                : `${activeRows.length} active expert${activeRows.length === 1 ? "" : "s"}`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {active.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <ResponsiveTable<ExpertRow>
                columns={columns}
                rows={activeRows}
                getRowId={(row) => row.id}
                empty={
                  <p className="text-center text-sm text-muted-foreground py-6">
                    No experts yet. Invite an expert to get started.
                  </p>
                }
              />
            )}
            {(active.data?.total ?? 0) > (active.data?.perPage ?? 20) && (
              <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
                <span className="tabular-nums">
                  Page {active.data?.page ?? page} of {totalPages}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    Prev
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
