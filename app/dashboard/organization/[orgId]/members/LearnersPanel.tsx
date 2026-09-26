"use client";

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { MemberStatus } from "@prisma/client";

import { useRequireOrgAccess } from "../useOrgRole";
import { PanelHeader } from "@/components/dashboard/PageScaffold";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { TablePagination } from "@/components/dashboard/TablePagination";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { MEMBER_STATUS_LABEL } from "@/lib/labels/org-labels";

interface Learner {
  id: string;
  status: MemberStatus;
  createdAt: string;
  user: {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
  };
}

const PAGE_SIZE = 25;

async function fetchLearners(
  orgId: string,
  page: number,
): Promise<{ learners: Learner[]; total: number }> {
  const res = await fetch(
    `/api/organizations/${orgId}/members?role=LEARNER&perPage=${PAGE_SIZE}&page=${page}`,
  );
  if (!res.ok) throw new Error("Failed to load learners");
  const json = await res.json();
  return { learners: json.data ?? [], total: json.meta?.total ?? 0 };
}

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
    // #1762-4 — the label map, not the raw enum.
    cell: (l) => (
      <StatusBadge
        label={MEMBER_STATUS_LABEL[l.status] ?? l.status}
        tone={l.status === "ACTIVE" ? "success" : "neutral"}
      />
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

export function LearnersPanel({ orgId }: { orgId: string }) {
  const { allowed } = useRequireOrgAccess(orgId, {
    permission: "learners.read",
    canSponsor: true,
  });
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["org-learners", orgId, page],
    queryFn: () => fetchLearners(orgId, page),
    placeholderData: keepPreviousData,
    enabled: allowed,
  });

  if (!allowed) return null;

  return (
    <>
      <PanelHeader description="Members consuming sessions on behalf of the organization" />
      <ResponsiveTable<Learner>
        columns={columns}
        rows={data?.learners ?? []}
        getRowId={(l) => l.id}
        isLoading={isLoading && !data}
        // A failed read used to render as "No learners yet" (#1527).
        error={isError ? "Couldn't load learners." : undefined}
        onRetry={() => void refetch()}
        empty="No learners yet. Add people from the Invitations tab."
      />
      {data && data.total > PAGE_SIZE && (
        <TablePagination
          page={page}
          pageSize={PAGE_SIZE}
          total={data.total}
          onPageChange={setPage}
        />
      )}
    </>
  );
}
