"use client";

import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";

import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/DashboardShell";
import { Badge } from "@/components/ui/badge";
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

interface ConsultantRow {
  id: string;
  status: string;
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

async function fetchConsultants(orgId: string): Promise<ConsultantsResponse> {
  const res = await fetch(`/api/organizations/${orgId}/consultants`);
  // 501 → return shape so the gated panel can render the "feature locked" UI.
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

  const { data, isLoading } = useQuery({
    queryKey: ["org-consultants", orgId],
    queryFn: () => fetchConsultants(orgId),
  });

  const isGated = !!data?.flag;

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
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {isLoading
                  ? "Loading…"
                  : `${data?.consultants?.length ?? 0} consultants`}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <p className="text-sm text-zinc-500">Loading…</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Consultant</TableHead>
                      <TableHead>Headline</TableHead>
                      <TableHead>Rating</TableHead>
                      <TableHead>Verified</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data?.consultants?.map((c) => (
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
                    {data?.consultants && data.consultants.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={4}
                          className="text-center text-sm text-zinc-500 py-6"
                        >
                          No consultants yet.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        )}
      </DashboardContent>
    </>
  );
}
