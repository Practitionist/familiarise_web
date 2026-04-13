"use client";

import { use, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Lock, CheckCircle2, XCircle, Loader2 } from "lucide-react";

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
import { useOrgRole } from "../useOrgRole";

interface ConsultantRow {
  id: string;
  status: string;
  earningsRecipient?: string;
  customConsultantPayoutRate?: number | null;
  applicationNote?: string | null;
  appliedAt?: string | null;
  consultantProfile: {
    id: string;
    headline: string | null;
    rating: number;
    isVerified: boolean;
  } | null;
  member: {
    user: { id: string; name: string | null; email: string };
  };
}

interface ConsultantsResponse {
  consultants?: ConsultantRow[];
  error?: string;
  flag?: string;
}

async function fetchConsultants(
  orgId: string,
  status?: string,
): Promise<ConsultantsResponse> {
  const url = status
    ? `/api/organizations/${orgId}/consultants?status=${status}`
    : `/api/organizations/${orgId}/consultants`;
  const res = await fetch(url);
  if (res.status === 501) return res.json();
  if (!res.ok) throw new Error("Failed to load consultants");
  return res.json();
}

export default function OrgConsultantsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const { isAtLeast } = useOrgRole(orgId);
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const active = useQuery({
    queryKey: ["org-consultants", orgId, "ACTIVE"],
    queryFn: () => fetchConsultants(orgId, "ACTIVE"),
  });

  const pending = useQuery({
    queryKey: ["org-consultants", orgId, "PENDING"],
    queryFn: () => fetchConsultants(orgId, "PENDING"),
    enabled: isAtLeast("ORG_ADMIN"),
  });

  const approvalAction = useMutation({
    mutationFn: async ({
      memberId,
      action,
    }: {
      memberId: string;
      action: "APPROVE" | "REJECT";
    }) => {
      const res = await fetch(`/api/organizations/${orgId}/consultants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId, action }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Action failed");
      }
      return res.json();
    },
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({
        queryKey: ["org-consultants", orgId],
      });
    },
    onError: (err: Error) => setActionError(err.message),
  });

  const isGated = !!active.data?.flag;
  const consultants = active.data?.consultants ?? [];
  const pendingApps = pending.data?.consultants ?? [];

  return (
    <>
      <DashboardHeader
        title="Consultants"
        subtitle="Consultants providing services under this organization"
      />
      <DashboardContent>
        {isGated ? (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Lock className="h-5 w-5 text-zinc-500" />
                <CardTitle>Provider tier required</CardTitle>
              </div>
              <CardDescription>
                Consultant agencies are part of the upcoming Provider tier.
                Contact us to enable it for your organization.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <>
            {/* Pending applications (ORG_ADMIN+) */}
            {isAtLeast("ORG_ADMIN") && pendingApps.length > 0 && (
              <Card className="mb-6 border-amber-200">
                <CardHeader>
                  <CardTitle className="text-base">
                    Pending Applications ({pendingApps.length})
                  </CardTitle>
                  <CardDescription>
                    Review and approve consultant applications
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {actionError && (
                    <p className="text-sm text-red-600 mb-3">{actionError}</p>
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
                      {pendingApps.map((c) => (
                        <TableRow key={c.id}>
                          <TableCell>
                            <div className="flex flex-col">
                              <span className="font-medium text-zinc-900">
                                {c.member.user.name ?? "—"}
                              </span>
                              <span className="text-xs text-zinc-500">
                                {c.member.user.email}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="text-sm text-zinc-600 max-w-xs truncate">
                            {c.applicationNote || "—"}
                          </TableCell>
                          <TableCell className="text-sm text-zinc-500">
                            {c.appliedAt
                              ? new Date(c.appliedAt).toLocaleDateString()
                              : "—"}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  approvalAction.mutate({
                                    memberId: c.id,
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
                                    memberId: c.id,
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

            {/* Active consultants */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {active.isLoading
                    ? "Loading…"
                    : `${consultants.length} active consultant${consultants.length !== 1 ? "s" : ""}`}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {active.isLoading ? (
                  <p className="text-sm text-zinc-500">Loading…</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Consultant</TableHead>
                        <TableHead>Headline</TableHead>
                        <TableHead>Rating</TableHead>
                        <TableHead>Earnings</TableHead>
                        <TableHead>Verified</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {consultants.map((c) => (
                        <TableRow key={c.id}>
                          <TableCell>
                            <div className="flex flex-col">
                              <span className="font-medium text-zinc-900">
                                {c.member.user.name ?? "—"}
                              </span>
                              <span className="text-xs text-zinc-500">
                                {c.member.user.email}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="text-sm text-zinc-600 max-w-xs truncate">
                            {c.consultantProfile?.headline ?? "—"}
                          </TableCell>
                          <TableCell>
                            {c.consultantProfile?.rating?.toFixed(1) ?? "—"}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                c.earningsRecipient === "ORGANIZATION"
                                  ? "secondary"
                                  : "outline"
                              }
                            >
                              {c.earningsRecipient === "ORGANIZATION"
                                ? "Internal"
                                : c.customConsultantPayoutRate != null
                                  ? `${(c.customConsultantPayoutRate * 100).toFixed(0)}%`
                                  : "Default"}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                c.consultantProfile?.isVerified
                                  ? "default"
                                  : "outline"
                              }
                            >
                              {c.consultantProfile?.isVerified ? "Yes" : "No"}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                      {consultants.length === 0 && (
                        <TableRow>
                          <TableCell
                            colSpan={5}
                            className="text-center text-sm text-zinc-500 py-6"
                          >
                            No consultants yet. Invite consultants or wait for
                            applications.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </DashboardContent>
    </>
  );
}
