"use client";

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { FilterBar } from "@/components/dashboard/FilterBar";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { TablePagination } from "@/components/dashboard/TablePagination";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { humanizeEnum } from "@/lib/ui/tone";
import type { UserListItem, UserListResponse } from "@/types/admin-users";

const PAGE_SIZE = 20; // the route's fixed page size

const ROLE_OPTIONS = ["CONSULTANT", "CONSULTEE", "STAFF", "ADMIN"].map(
  (value) => ({ value, label: humanizeEnum(value) }),
);

const initials = (u: UserListItem) =>
  (u.name || u.email || "?")
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

const columns: ResponsiveColumn<UserListItem>[] = [
  {
    key: "user",
    header: "User",
    primary: true,
    cell: (user) => (
      <div className="flex items-center gap-3">
        <Avatar>
          <AvatarImage src={user.image || ""} />
          <AvatarFallback>{initials(user)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="font-medium text-foreground">
            {user.name || "Unnamed"}
          </p>
          <p className="text-sm text-muted-foreground">{user.email}</p>
        </div>
      </div>
    ),
  },
  {
    key: "role",
    header: "Role",
    cell: (user) => humanizeEnum(user.role ?? "none"),
  },
  {
    key: "status",
    header: "Onboarding",
    cell: (user) =>
      user.onboardingCompleted ? (
        <StatusBadge label="Complete" tone="success" variant="dot" />
      ) : (
        <StatusBadge label="Not finished" tone="caution" variant="dot" />
      ),
  },
  {
    key: "joined",
    header: "Joined",
    className: "text-sm text-muted-foreground",
    cell: (user) => new Date(user.createdAt).toLocaleDateString(),
  },
];

/**
 * #1527 — the user directory. Each row opens User 360 (it used to open a
 * profile-only modal); the verification queue moved to its own page.
 */
export function OperatorUsersPage() {
  const { basePath } = useBackofficeCapability();
  const [search, setSearch] = useState("");
  const [role, setRole] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ["operator-users", page, search, role],
    queryFn: async (): Promise<UserListResponse> => {
      const params = new URLSearchParams({ page: String(page) });
      if (search) params.set("search", search);
      if (role) params.set("role", role);
      const response = await fetch(`/api/admin/users?${params}`);
      if (!response.ok) throw new Error("Failed to fetch users");
      return response.json();
    },
    // Keep the current page on screen while the next one loads.
    placeholderData: keepPreviousData,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        description={`${data?.total ?? 0} people on the platform. Open one for their bookings, payments, tickets and reports.`}
      />
      <ResponsiveTable<UserListItem>
        columns={columns}
        rows={data?.users ?? []}
        getRowId={(u) => u.id}
        getRowHref={(u) => `${basePath}/users/${u.id}`}
        isLoading={isPending && !data}
        error={error && !data ? error : undefined}
        onRetry={() => void refetch()}
        toolbar={
          <FilterBar
            search={{
              label: "Search users",
              placeholder: "Name or email",
              value: search,
              onChange: (v) => {
                setSearch(v);
                setPage(1);
              },
            }}
            chips={{
              label: "Role",
              options: ROLE_OPTIONS,
              value: role,
              onChange: (v) => {
                setRole(v);
                setPage(1);
              },
              clearable: true,
            }}
          />
        }
        empty={
          <p className="py-10 text-center text-sm text-muted-foreground">
            No users match these filters.
          </p>
        }
      />
      <TablePagination
        page={page}
        pageSize={PAGE_SIZE}
        total={data?.total ?? 0}
        onPageChange={setPage}
      />
    </div>
  );
}
