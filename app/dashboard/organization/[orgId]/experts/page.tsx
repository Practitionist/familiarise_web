"use client";

import { use } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";

import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/DashboardShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
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
import { useOrgRole, useRequireOrgAccess } from "../useOrgRole";
import type { MemberStatus } from "@prisma/client";

// ---------------------------------------------------------------------------
// Types — rows come from GET /api/organizations/[orgId]/members?role=EXPERT
// ---------------------------------------------------------------------------

interface ExpertRow {
  id: string;
  status: MemberStatus;
  applicationNote: string | null;
  appliedAt: string | null;
  approvedAt: string | null;
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

async function updateMemberStatus(
  orgId: string,
  memberId: string,
  status: MemberStatus,
): Promise<void> {
  const res = await fetch(
    `/api/organizations/${orgId}/members/${memberId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? "Failed to update status",
    );
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function OrgExpertsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const { isAtLeast } = useOrgRole(orgId);
  const { allowed } = useRequireOrgAccess(orgId, {
    minRole: "MANAGER",
    canHost: true,
  });
  const queryClient = useQueryClient();

  const active = useQuery({
    queryKey: ["org-experts", orgId, "ACTIVE"],
    queryFn: () => fetchExperts(orgId, "ACTIVE"),
    enabled: allowed,
  });
  const pending = useQuery({
    queryKey: ["org-experts", orgId, "PENDING"],
    queryFn: () => fetchExperts(orgId, "PENDING"),
    enabled: allowed && isAtLeast("MAINTAINER"),
  });

  const approvalAction = useMutation({
    mutationFn: async (args: {
      memberId: string;
      action: "APPROVE" | "REJECT";
    }) => {
      // APPROVE moves PENDING → ACTIVE; REJECT moves PENDING → REMOVED.
      // The members PATCH route handles the audit log + transition guards.
      await updateMemberStatus(
        orgId,
        args.memberId,
        args.action === "APPROVE" ? "ACTIVE" : "REMOVED",
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-experts", orgId] });
    },
  });

  if (!allowed) return null;

  const activeRows = active.data?.data ?? [];
  const pendingRows = pending.data?.data ?? [];

  return (
    <>
      <DashboardHeader
        title="Experts"
        subtitle="Experts providing services under this organization"
      />
      <DashboardContent>
        {/* Pending applications (MAINTAINER+) */}
        {isAtLeast("MAINTAINER") && pendingRows.length > 0 && (
          <Card className="mb-6 border-amber-200">
            <CardHeader>
              <CardTitle className="text-base">
                Pending applications ({pendingRows.length})
              </CardTitle>
              <CardDescription>
                Review and approve expert applications.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {approvalAction.error && (
                <p className="text-sm text-red-600 mb-3">
                  {(approvalAction.error as Error).message}
                </p>
              )}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Applicant</TableHead>
                    <TableHead>Note</TableHead>
                    <TableHead>Applied</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pendingRows.map((row) => (
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
                        {row.applicationNote || "—"}
                      </TableCell>
                      <TableCell className="text-sm text-zinc-500">
                        {row.appliedAt
                          ? new Date(row.appliedAt).toLocaleDateString()
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              approvalAction.mutate({
                                memberId: row.id,
                                action: "APPROVE",
                              })
                            }
                            disabled={approvalAction.isPending}
                          >
                            {approvalAction.isPending ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <CheckCircle2 className="h-3 w-3 mr-1" />
                            )}
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-red-600 hover:text-red-700"
                            onClick={() =>
                              approvalAction.mutate({
                                memberId: row.id,
                                action: "REJECT",
                              })
                            }
                            disabled={approvalAction.isPending}
                          >
                            <XCircle className="h-3 w-3 mr-1" />
                            Reject
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        {/* Active experts */}
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
                        No experts yet. Invite experts or wait for
                        applications.
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
