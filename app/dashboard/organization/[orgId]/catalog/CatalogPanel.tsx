"use client";

import { useMemo, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Library, Archive, Undo2, Loader2 } from "lucide-react";

import { EmptyState } from "@/components/dashboard/DataCard";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Button } from "@/components/ui/button";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { isArchivedCatalogView } from "@/lib/dashboard/org-tab-redirect";
import { replaceUrl } from "@/lib/navigation/history";
import { formatCurrencyAmount } from "@/utils/formatting";

import type { CatalogRow, Kind } from "./types";

const VISIBILITY_LABEL: Record<CatalogRow["visibility"], string> = {
  PUBLIC: "Public",
  ORG_ONLY: "Members only",
  ORG_AND_PUBLIC: "Public + members",
};

/** The status chips; "ARCHIVED" alone lists withdrawn plans. */
type StatusFilter = "ALL" | "PUBLISHED" | "DRAFT" | "ARCHIVED";

export function isCatalogRowDraft(row: CatalogRow): boolean {
  if (typeof row.isDraft === "boolean") return row.isDraft;
  if (row.status) return row.status === "DRAFT";
  const instances = row.webinars ?? row.classes;
  if (Array.isArray(instances) && instances.length > 0) {
    return instances.every((inst) => inst.status === "DRAFT");
  }
  return false;
}

export function resolveCatalogTopicCount(row: CatalogRow): number {
  if (typeof row.topicsCount === "number") return row.topicsCount;
  if (typeof row._count?.topics === "number") return row._count.topics;
  if (Array.isArray(row.topics)) return row.topics.length;
  return 0;
}

export function resolveCatalogExpertName(
  row: CatalogRow,
  expertNamesById?: Record<string, string>,
): string {
  if (row.consultantName) return row.consultantName;
  if (row.consultantProfile?.user?.name) return row.consultantProfile.user.name;
  if (row.consultantProfile?.user?.email) {
    return row.consultantProfile.user.email;
  }
  if (row.consultantProfileId && expertNamesById?.[row.consultantProfileId]) {
    return expertNamesById[row.consultantProfileId];
  }
  return "—";
}

function RowStatusBadge({ row }: Readonly<{ row: CatalogRow }>) {
  if (row.archivedAt) {
    return <StatusBadge label="Archived" tone="neutral" size="sm" />;
  }
  return isCatalogRowDraft(row) ? (
    <StatusBadge label="Draft" tone="caution" size="sm" />
  ) : (
    <StatusBadge label="Published" tone="success" size="sm" />
  );
}

/** The status chips; Archived toggles, so a second press returns to All. */
function StatusChips({
  filter,
  onChange,
  showLive,
  showArchived,
}: Readonly<{
  filter: StatusFilter;
  onChange: (next: StatusFilter) => void;
  showLive: boolean;
  showArchived: boolean;
}>) {
  const options = [
    { value: "ALL", label: "All statuses", show: showLive },
    { value: "PUBLISHED", label: "Published", show: showLive },
    { value: "DRAFT", label: "Drafts", show: showLive },
    { value: "ARCHIVED", label: "Archived", show: showArchived },
  ] as const;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {options
        .filter((opt) => opt.show)
        .map((opt) => (
          <Button
            key={opt.value}
            type="button"
            size="sm"
            variant={filter === opt.value ? "secondary" : "ghost"}
            aria-pressed={filter === opt.value}
            className="h-7 px-2.5 text-xs"
            onClick={() =>
              onChange(
                opt.value === "ARCHIVED" && filter === "ARCHIVED"
                  ? "ALL"
                  : opt.value,
              )
            }
          >
            {opt.label}
          </Button>
        ))}
    </div>
  );
}

/**
 * One kind's table.
 *
 * Split out of `CatalogClient` for the reason `MembersTabs` and `SettingsTabs`
 * already pass component references rather than inline markup: `UrlTabs` writes
 * the active tab through `router.replace`, and Next 15's App Router re-renders
 * the tree via `useSearchParams` reactivity even with `{ scroll: false }` —
 * documented at `app/explore/hooks/useUrlSyncedFilters.ts:34`. When that
 * re-render lands, a tab body that is an element reference costs almost nothing
 * to reconcile, whereas the previous inline `renderList(...)` calls rebuilt
 * BOTH kinds' full row sets, columns array and cell closures on every tab
 * switch. Radix unmounts the inactive panel, so only the visible kind's rows
 * are built now.
 */
export function CatalogPanel({
  kind,
  rows,
  isLoading,
  error,
  onToggleArchive,
  isMutating,
  expertNamesById,
  blocked,
}: Readonly<{
  kind: Kind;
  rows: CatalogRow[];
  isLoading: boolean;
  error: unknown;
  onToggleArchive: (planId: string, restore: boolean) => void;
  isMutating: boolean;
  expertNamesById?: Record<string, string>;
  /** Replaces the live list when nobody can deliver; Archived still opens. */
  blocked?: ReactNode;
}>) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Archived lives in the URL (`?status=archived`), read every render so any
  // navigation into or out of it applies; the live chips are local.
  const archivedView = isArchivedCatalogView(searchParams?.get("status"));
  const [liveFilter, setLiveFilter] =
    useState<Exclude<StatusFilter, "ARCHIVED">>("ALL");
  // The Archived view never falls back to live rows; with none it says so.
  const filter: StatusFilter = archivedView ? "ARCHIVED" : liveFilter;

  const setStatusFilter = (next: StatusFilter) => {
    if (next !== "ARCHIVED") setLiveFilter(next);
    if ((next === "ARCHIVED") === archivedView) return;
    const params = new URLSearchParams(window.location.search);
    if (next === "ARCHIVED") params.set("status", "archived");
    else params.delete("status");
    const qs = params.toString();
    replaceUrl(qs ? `${pathname}?${qs}` : pathname);
  };
  const hasArchived = rows.some((r) => r.archivedAt !== null);

  const filteredRows = useMemo(
    () =>
      rows.filter((r) => {
        if (filter === "ARCHIVED") return r.archivedAt !== null;
        if (r.archivedAt !== null) return false;
        if (filter === "ALL") return true;
        return isCatalogRowDraft(r) === (filter === "DRAFT");
      }),
    [rows, filter],
  );

  // Memoized so the array and its cell closures survive re-renders that do not
  // change the handler — previously reallocated on every call, twice per render.
  const columns = useMemo<ResponsiveColumn<CatalogRow>[]>(
    () => [
      {
        key: "title",
        header: "Offering",
        primary: true,
        cell: (r) => (
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{r.title}</span>
            <RowStatusBadge row={r} />
          </div>
        ),
      },
      {
        key: "expert",
        header: "Delivered by",
        cell: (r) => (
          <span className="text-muted-foreground">
            {resolveCatalogExpertName(r, expertNamesById)}
          </span>
        ),
      },
      {
        key: "topics",
        header: "Topics",
        className: "tabular-nums",
        cell: (r) => {
          const count = resolveCatalogTopicCount(r);
          return (
            <span className="text-muted-foreground">
              {count} {count === 1 ? "topic" : "topics"}
            </span>
          );
        },
      },
      {
        key: "price",
        header: "Price",
        cell: (r) => formatCurrencyAmount(Number(r.price), "INR"),
      },
      {
        key: "visibility",
        header: "Visibility",
        cell: (r) => VISIBILITY_LABEL[r.visibility],
      },
      {
        key: "seats",
        header: "Seats",
        cell: (r) => r.maxParticipants,
      },
      {
        key: "actions",
        header: "",
        hideOnCard: true,
        cell: (r) => {
          const archived = r.archivedAt !== null;
          return (
            <Button
              variant="ghost"
              size="sm"
              aria-label={`${archived ? "Restore" : "Withdraw"} ${r.title}`}
              title={
                archived
                  ? "Put back on sale"
                  : "Withdraw from sale. Existing bookings are unaffected."
              }
              disabled={isMutating}
              onClick={() => onToggleArchive(r.id, archived)}
            >
              {archived ? (
                <Undo2 className="h-4 w-4" />
              ) : (
                <Archive className="h-4 w-4" />
              )}
            </Button>
          );
        },
      },
    ],
    [onToggleArchive, isMutating, expertNamesById],
  );

  if (isLoading) {
    if (blocked) return blocked;
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Loading the catalog…
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={Library}
        title="Couldn't load the catalog"
        description={error instanceof Error ? error.message : undefined}
      />
    );
  }

  if (blocked && !hasArchived) return blocked;

  const noun = kind === "WEBINAR" ? "webinars" : "classes";

  if (filter === "ARCHIVED" && !hasArchived) {
    return (
      <EmptyState
        icon={Archive}
        title={`No archived ${noun}`}
        description="Offerings you withdraw from sale are listed here."
        action={
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setStatusFilter("ALL")}
          >
            Show live {noun}
          </Button>
        }
      />
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Library}
        title={`No ${noun} yet`}
        description="Offerings you publish here are owned by the organization and delivered by one of its experts."
      />
    );
  }

  return (
    <div className="space-y-3">
      <StatusChips
        filter={filter}
        onChange={setStatusFilter}
        showLive={!blocked}
        showArchived={hasArchived}
      />
      {blocked && filter !== "ARCHIVED" ? (
        blocked
      ) : (
        <ResponsiveTable
          columns={columns}
          rows={filteredRows}
          getRowId={(r) => r.id}
          empty="No offerings match the selected status filter."
        />
      )}
    </div>
  );
}
