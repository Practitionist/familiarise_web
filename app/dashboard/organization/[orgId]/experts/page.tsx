"use client";

import { use } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/DashboardShell";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
    rating: number;
    isVerified: boolean;
  } | null;
}

async function fetchExperts(
  orgId: string,
  status?: MemberStatus,
): Promise<{ data: ExpertRow[] }> {
  const params = new URLSearchParams({ role: "EXPERT", perPage: "100" });
  if (status) params.set("status", status);
  const res = await fetch(`/api/organizations/${orgId}/members?${params}`);
  if (!res.ok) throw new Error("Failed to load experts");
  return res.json();
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
export default function OrgExpertsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const { allowed } = useRequireOrgAccess(orgId, {
    minRole: "MANAGER",
    canHost: true,
  });

  const active = useQuery({
    queryKey: ["org-experts", orgId, "ACTIVE"],
    queryFn: () => fetchExperts(orgId, "ACTIVE"),
    enabled: allowed,
  });

  if (!allowed) return null;

  const activeRows = active.data?.data ?? [];

  return (
    <>
      <DashboardHeader
        title="Experts"
        subtitle="Experts providing services under this organization"
      />
      <DashboardContent>
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
              <p className="text-sm text-zinc-500">Loading…</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Expert</TableHead>
                    <TableHead>Headline</TableHead>
                    <TableHead>Rating</TableHead>
                    <TableHead>Payout</TableHead>
                    <TableHead>Verified</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activeRows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium text-zinc-900">
                            {row.user.name ?? "—"}
                          </span>
                          <span className="text-xs text-zinc-500">
                            {row.user.email}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-zinc-600 max-w-xs truncate">
                        {row.consultantProfile?.headline ?? "—"}
                      </TableCell>
                      <TableCell>
                        {row.consultantProfile?.rating?.toFixed(1) ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            row.payoutRecipient === "ORGANIZATION"
                              ? "secondary"
                              : "outline"
                          }
                        >
                          {row.payoutRecipient === "ORGANIZATION"
                            ? "Org (internal)"
                            : "Self"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            row.consultantProfile?.isVerified
                              ? "default"
                              : "outline"
                          }
                        >
                          {row.consultantProfile?.isVerified ? "Yes" : "No"}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                  {activeRows.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="text-center text-sm text-zinc-500 py-6"
                      >
                        No experts yet. Invite an expert to get started.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </DashboardContent>
    </>
  );
}
