"use client";

/**
 * Members › All for members without the full roster grant (#1527 decision 3):
 * who is in the organization — name, avatar and role — and nothing else.
 * Emails, status and usage stay on the operators' table (`members.read`).
 */

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { MemberRole } from "@prisma/client";
import { Users } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { FilterBar } from "@/components/dashboard/FilterBar";
import { TablePagination } from "@/components/dashboard/TablePagination";
import { MEMBER_ROLE_LABEL } from "@/lib/labels/org-labels";
import { getInitials } from "@/utils/formatting";

const PER_PAGE = 50;

interface DirectoryEntry {
  id: string;
  role: MemberRole;
  name: string | null;
  image: string | null;
}

interface DirectoryPage {
  data: DirectoryEntry[];
  total: number;
}

async function fetchDirectory(
  orgId: string,
  q: string,
  page: number,
): Promise<DirectoryPage> {
  const params = new URLSearchParams({
    page: String(page),
    perPage: String(PER_PAGE),
  });
  if (q) params.set("q", q);
  const res = await fetch(
    `/api/organizations/${orgId}/members/directory?${params.toString()}`,
  );
  if (!res.ok) throw new Error("Couldn't load the member directory");
  return (await res.json()) as DirectoryPage;
}

export function MemberDirectoryPanel({ orgId }: Readonly<{ orgId: string }>) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  const directory = useQuery({
    queryKey: ["org-member-directory", orgId, q, page],
    queryFn: () => fetchDirectory(orgId, q, page),
    placeholderData: keepPreviousData,
  });

  let body: React.ReactNode;
  if (directory.isPending) {
    body = <p className="text-sm text-muted-foreground">Loading…</p>;
  } else if (directory.isError) {
    body = (
      <ErrorState
        title="Couldn't load members"
        onRetry={() => void directory.refetch()}
      />
    );
  } else if (directory.data.data.length === 0) {
    body = (
      <EmptyState
        icon={Users}
        title={q ? "No members match that name" : "No members yet"}
      />
    );
  } else {
    body = (
      <>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {directory.data.data.map((m) => {
            const name = m.name ?? "Unnamed member";
            return (
              <li key={m.id} className="flex items-center gap-3 px-3 py-2.5">
                <Avatar className="h-8 w-8">
                  {m.image && <AvatarImage src={m.image} alt="" />}
                  <AvatarFallback className="text-xs">
                    {getInitials(name)}
                  </AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {name}
                </span>
                <span className="text-xs text-muted-foreground">
                  {MEMBER_ROLE_LABEL[m.role]}
                </span>
              </li>
            );
          })}
        </ul>
        <TablePagination
          page={page}
          pageSize={PER_PAGE}
          total={directory.data.total}
          onPageChange={setPage}
        />
      </>
    );
  }

  return (
    <div className="space-y-4">
      <FilterBar
        search={{
          label: "Search members by name",
          placeholder: "Search by name",
          value: q,
          // FilterBar debounces; a new term starts from page 1.
          onChange: (value) => {
            setQ(value.trim());
            setPage(1);
          },
        }}
      />
      {body}
    </div>
  );
}
