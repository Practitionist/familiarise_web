"use client";

/**
 * The Members tab for members without the full roster grant (#1527 decision
 * 3): who is in the organization — name, avatar and role — and nothing else.
 * Emails, status and usage stay on the operators' table (`members.read`).
 * Search, role and page live in the URL like the operators' list.
 */

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { MemberRole } from "@prisma/client";
import { Users } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { FilterBar } from "@/components/dashboard/FilterBar";
import { TablePagination } from "@/components/dashboard/TablePagination";
import { useListParams } from "@/hooks/useListParams";
import { MEMBER_ROLE_LABEL, MemberRoleSchema } from "@/lib/labels/org-labels";
import { getInitials } from "@/utils/formatting";

const PER_PAGE = 50;
const ALL_ROLES = "ALL";
const FILTER_KEYS = ["role"] as const;
const ROLE_OPTIONS = [
  { value: ALL_ROLES, label: "All roles" },
  ...MemberRoleSchema.options.map((value) => ({
    value,
    label: MEMBER_ROLE_LABEL[value],
  })),
];

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
  role: MemberRole | undefined,
  page: number,
): Promise<DirectoryPage> {
  const params = new URLSearchParams({
    page: String(page),
    perPage: String(PER_PAGE),
  });
  if (q) params.set("q", q);
  if (role) params.set("role", role);
  const res = await fetch(
    `/api/organizations/${orgId}/members/directory?${params.toString()}`,
  );
  if (!res.ok) throw new Error("Couldn't load the member directory");
  return (await res.json()) as DirectoryPage;
}

export function MemberDirectoryPanel({ orgId }: Readonly<{ orgId: string }>) {
  const { q, page, filters, setQ, setPage, setFilter, clear } = useListParams({
    filterKeys: FILTER_KEYS,
  });
  // A stale or hand-edited ?role= reads as "all roles", not a 400.
  const parsedRole = MemberRoleSchema.safeParse(filters.role);
  const role = parsedRole.success ? parsedRole.data : undefined;

  const directory = useQuery({
    queryKey: ["org-member-directory", orgId, q, role, page],
    queryFn: () => fetchDirectory(orgId, q, role, page),
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
        title={q || role ? "No members match these filters" : "No members yet"}
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
          // FilterBar debounces; useListParams resets to page 1.
          onChange: setQ,
        }}
        selects={[
          {
            key: "role",
            label: "Role",
            value: role ?? ALL_ROLES,
            options: ROLE_OPTIONS,
            onChange: (value) =>
              setFilter("role", value === ALL_ROLES ? null : value),
          },
        ]}
        onClear={clear}
        canClear={Boolean(q || role)}
      />
      {body}
    </div>
  );
}
