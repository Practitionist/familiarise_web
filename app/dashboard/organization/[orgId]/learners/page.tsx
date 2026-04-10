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

interface Learner {
  id: string;
  status: string;
  seatAssignedAt: string | null;
  user: {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
  };
}

async function fetchLearners(
  orgId: string,
): Promise<{ learners: Learner[]; total: number }> {
  const res = await fetch(`/api/organizations/${orgId}/learners?limit=100`);
  if (!res.ok) throw new Error("Failed to load learners");
  return res.json();
}

export default function OrgLearnersPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);

  const { data, isLoading } = useQuery({
    queryKey: ["org-learners", orgId],
    queryFn: () => fetchLearners(orgId),
  });

  return (
    <>
      <DashboardHeader
        title="Learners"
        subtitle="Members consuming sessions on behalf of the organization"
      />
      <DashboardContent>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {isLoading ? "Loading…" : `${data?.total ?? 0} learners`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-sm text-zinc-500">Loading…</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Learner</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Seat assigned</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data?.learners.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium text-zinc-900">
                            {l.user.name ?? "—"}
                          </span>
                          <span className="text-xs text-zinc-500">
                            {l.user.email}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            l.status === "ACTIVE" ? "default" : "outline"
                          }
                        >
                          {l.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-zinc-500">
                        {l.seatAssignedAt
                          ? new Date(l.seatAssignedAt).toLocaleDateString()
                          : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                  {data && data.learners.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={3}
                        className="text-center text-sm text-zinc-500 py-6"
                      >
                        No learners yet. Invite some via the Invitations page.
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
