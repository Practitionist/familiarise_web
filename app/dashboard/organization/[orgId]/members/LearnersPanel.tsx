"use client";

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRequireOrgAccess } from "../useOrgRole";

import { PanelHeader } from "@/components/dashboard/PageScaffold";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";

interface Learner {
  id: string;
  status: string;
  createdAt: string;
  user: {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
  };
}

async function fetchLearners(
  orgId: string,
  page: number,
): Promise<{ learners: Learner[]; total: number; page: number; perPage: number }> {
  const params = new URLSearchParams({
    role: "LEARNER",
    page: String(page),
    perPage: "20",
  });
  const res = await fetch(`/api/organizations/${orgId}/members?${params}`);
  if (!res.ok) throw new Error("Failed to load learners");
  const json = await res.json();
  return {
    learners: json.data ?? [],
    total: json.meta?.total ?? 0,
    page: json.meta?.page ?? page,
    perPage: json.meta?.perPage ?? 20,
  };
}

export function LearnersPanel({ orgId }: { orgId: string }) {
  const { allowed } = useRequireOrgAccess(orgId, {
    permission: "learners.read",
    canSponsor: true,
  });
  // Server-paginated (was a fixed perPage=100 with no pager, so large orgs
  // paid the full roster on every tab visit and small orgs saw no change).
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ["org-learners", orgId, page],
    queryFn: () => fetchLearners(orgId, page),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  const totalPages = Math.max(
    1,
    Math.ceil((data?.total ?? 0) / (data?.perPage ?? 20)),
  );

  if (!allowed) return null;

  const columns: ResponsiveColumn<Learner>[] = [
    {
      key: "learner",
      header: "Learner",
      primary: true,
      cell: (l) => (
        <div className="flex flex-col">
          <span className="font-medium text-foreground">
            {l.user.name ?? "—"}
          </span>
          <span className="text-xs text-muted-foreground">{l.user.email}</span>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (l) => (
        <Badge variant={l.status === "ACTIVE" ? "default" : "outline"}>
          {l.status}
        </Badge>
      ),
    },
    {
      key: "since",
      header: "Member since",
      cell: (l) => (
        <span className="text-xs text-muted-foreground">
          {new Date(l.createdAt).toLocaleDateString()}
        </span>
      ),
    },
  ];

  return (
    <>
      <PanelHeader description="Members consuming sessions on behalf of the organization" />
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {isLoading ? "Loading…" : `${data?.total ?? 0} learners`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <ResponsiveTable<Learner>
                columns={columns}
                rows={data?.learners ?? []}
                getRowId={(l) => l.id}
                empty={
                  <p className="text-center text-sm text-muted-foreground py-6">
                    No learners yet. Invite some via the Invitations page.
                  </p>
                }
              />
            )}
            {(data?.total ?? 0) > (data?.perPage ?? 20) && (
              <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
                <span className="tabular-nums">
                  Page {data?.page ?? page} of {totalPages}
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
