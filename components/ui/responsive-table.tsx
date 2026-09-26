"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/utils/tailwind";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/dashboard/ErrorState";

export type SortDir = "asc" | "desc";

export interface TableSort {
  key: string;
  dir: SortDir;
}

export interface ResponsiveColumn<T> {
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  /** Used as the card title on mobile. Mark exactly one column primary. */
  primary?: boolean;
  /** Omit this column from the mobile card view. */
  hideOnCard?: boolean;
  /** Label beside the value on the mobile card; defaults to `header`. */
  cardLabel?: React.ReactNode;
  /** Header becomes a sort button when the table has `onSortChange`. */
  sortable?: boolean;
  className?: string;
  headClassName?: string;
}

export interface ResponsiveTableProps<T> {
  columns: ResponsiveColumn<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  selectable?: boolean;
  selectedIds?: Set<string>;
  onToggle?: (id: string) => void;
  onToggleAll?: () => void;
  allSelected?: boolean;
  /** Shown sticky under the list while at least one row is selected. */
  bulkBar?: React.ReactNode;
  rowActions?: (row: T) => React.ReactNode;
  /**
   * Makes each row a real link: the primary (else first) cell renders a
   * `next/link` (so that cell must not render a link of its own), which makes
   * Tab + Enter, middle-click and "open in new tab" work; a click anywhere
   * else on the row follows it. Wins over `onRowClick`.
   */
  getRowHref?: (row: T) => string | undefined;
  onRowClick?: (row: T) => void;
  empty?: React.ReactNode;
  /** Pass `isLoading && !data` so a refetch keeps the previous rows on screen. */
  isLoading?: boolean;
  loadingRows?: number;
  /** Any truthy value renders the inline ErrorState in place of the rows. */
  error?: unknown;
  onRetry?: () => void;
  /** Filters, search and counts above the list. */
  toolbar?: React.ReactNode;
  sort?: TableSort | null;
  onSortChange?: (sort: TableSort) => void;
  /** Below this width rows render as stacked cards. Default "md". */
  breakpoint?: "sm" | "md" | "lg";
  className?: string;
}

// Static class pairs so Tailwind's JIT can see them.
const SWITCH: Record<string, { table: string; cards: string }> = {
  sm: { table: "hidden sm:block", cards: "grid gap-3 sm:hidden" },
  md: { table: "hidden md:block", cards: "grid gap-3 md:hidden" },
  lg: { table: "hidden lg:block", cards: "grid gap-3 lg:hidden" },
};

const INTERACTIVE =
  "a,button,input,textarea,select,label,[role=checkbox],[role=menuitem]";

/** A click on the row body follows the row's link, unless it hit a control. */
function followRowLink(e: React.MouseEvent<HTMLElement>) {
  const target = e.target as HTMLElement;
  if (target.closest(INTERACTIVE)) return;
  if (window.getSelection()?.toString()) return;
  e.currentTarget.querySelector<HTMLAnchorElement>("a[data-row-link]")?.click();
}

/** Enter / Space on a focused clickable row, not on a control inside it. */
function onRowKey(e: React.KeyboardEvent<HTMLElement>, run: () => void) {
  if (e.target !== e.currentTarget) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    run();
  }
}

function nextSort(current: TableSort | null | undefined, key: string) {
  if (current?.key === key) {
    return { key, dir: current.dir === "asc" ? "desc" : "asc" } as TableSort;
  }
  return { key, dir: "asc" } as TableSort;
}

function ariaSort(current: TableSort | null | undefined, key: string) {
  if (current?.key !== key) return "none" as const;
  return current.dir === "asc"
    ? ("ascending" as const)
    : ("descending" as const);
}

function SortIcon({ dir }: Readonly<{ dir?: SortDir }>) {
  const cls = "h-3.5 w-3.5 shrink-0";
  if (dir === "asc") return <ArrowUp className={cls} aria-hidden />;
  if (dir === "desc") return <ArrowDown className={cls} aria-hidden />;
  return <ChevronsUpDown className={cn(cls, "opacity-50")} aria-hidden />;
}

/**
 * Selection state for a `selectable` table. Pass the visible row ids; a
 * selected id that leaves the page stops counting as selected.
 */
export function useRowSelection(visibleIds: string[]) {
  const [picked, setPicked] = React.useState<Set<string>>(() => new Set());
  const selectedIds = React.useMemo(
    () => new Set(visibleIds.filter((id) => picked.has(id))),
    [visibleIds, picked],
  );
  const allSelected =
    visibleIds.length > 0 && selectedIds.size === visibleIds.length;
  return {
    selectedIds,
    allSelected,
    onToggle: (id: string) =>
      setPicked((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    onToggleAll: () => setPicked(new Set(allSelected ? [] : visibleIds)),
    clear: () => setPicked(new Set()),
  };
}

function LoadingBody({
  columnCount,
  rowCount,
  sw,
}: Readonly<{
  columnCount: number;
  rowCount: number;
  sw: { table: string; cards: string };
}>) {
  const rowKeys = Array.from({ length: rowCount }, (_, i) => `sk-row-${i}`);
  const colKeys = Array.from({ length: columnCount }, (_, i) => `sk-col-${i}`);
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">Loading…</span>
      <div className={cn(sw.table, "space-y-3 py-2")}>
        {rowKeys.map((rk) => (
          <div key={rk} className="flex items-center gap-4 px-2 py-2">
            {colKeys.map((ck) => (
              <Skeleton key={ck} className="h-4 flex-1" />
            ))}
          </div>
        ))}
      </div>
      <div className={sw.cards}>
        {rowKeys.map((rk) => (
          <Skeleton key={rk} className="h-24 rounded-xl" />
        ))}
      </div>
    </div>
  );
}

/**
 * The dashboard list primitive (#1527 §15, "DataTable"): a real table at the
 * breakpoint and stacked cards below it, with loading, error and empty states,
 * keyboard-operable rows, optional sorting and a bulk bar.
 */
export function ResponsiveTable<T>({
  columns,
  rows,
  getRowId,
  selectable,
  selectedIds,
  onToggle,
  onToggleAll,
  allSelected,
  bulkBar,
  rowActions,
  getRowHref,
  onRowClick,
  empty,
  isLoading = false,
  loadingRows = 5,
  error,
  onRetry,
  toolbar,
  sort,
  onSortChange,
  breakpoint = "md",
  className,
}: ResponsiveTableProps<T>) {
  const sw = SWITCH[breakpoint];
  const isSelected = (id: string) => selectedIds?.has(id) ?? false;

  const primary = columns.find((c) => c.primary);
  const linkColumnKey = (primary ?? columns[0])?.key;
  const cardColumns = columns.filter((c) => !c.primary && !c.hideOnCard);

  const renderCell = (col: ResponsiveColumn<T>, row: T) => {
    const href = getRowHref?.(row);
    if (!href || col.key !== linkColumnKey) return col.cell(row);
    return (
      <Link
        href={href}
        data-row-link=""
        className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {col.cell(row)}
      </Link>
    );
  };

  /** Click + keyboard wiring shared by the table row and the mobile card. */
  const rowInteraction = (row: T) => {
    if (getRowHref?.(row)) {
      return { onClick: followRowLink, className: "cursor-pointer" };
    }
    if (onRowClick) {
      return {
        onClick: () => onRowClick(row),
        onKeyDown: (e: React.KeyboardEvent<HTMLElement>) =>
          onRowKey(e, () => onRowClick(row)),
        tabIndex: 0,
        className:
          "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      };
    }
    return {};
  };

  let body: React.ReactNode;
  if (error) {
    body = <ErrorState onRetry={onRetry} />;
  } else if (isLoading) {
    body = (
      <LoadingBody
        columnCount={Math.min(columns.length, 5)}
        rowCount={loadingRows}
        sw={sw}
      />
    );
  } else if (rows.length === 0 && empty) {
    body = empty;
  } else {
    body = (
      <>
        {/* Desktop / tablet: real table */}
        <div className={sw.table}>
          <Table>
            <TableHeader>
              <TableRow>
                {selectable && (
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={() => onToggleAll?.()}
                      aria-label="Select all rows"
                    />
                  </TableHead>
                )}
                {columns.map((col) => {
                  const sortable = Boolean(col.sortable && onSortChange);
                  const active = sort?.key === col.key ? sort.dir : undefined;
                  return (
                    <TableHead
                      key={col.key}
                      className={col.headClassName}
                      aria-sort={sortable ? ariaSort(sort, col.key) : undefined}
                    >
                      {sortable ? (
                        <button
                          type="button"
                          onClick={() =>
                            onSortChange?.(nextSort(sort, col.key))
                          }
                          className="-mx-1 inline-flex items-center gap-1 rounded-sm px-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {col.header}
                          <SortIcon dir={active} />
                        </button>
                      ) : (
                        col.header
                      )}
                    </TableHead>
                  );
                })}
                {rowActions && <TableHead className="w-10 text-right" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const id = getRowId(row);
                const interaction = rowInteraction(row);
                return (
                  <TableRow
                    key={id}
                    data-state={isSelected(id) ? "selected" : undefined}
                    {...interaction}
                  >
                    {selectable && (
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={isSelected(id)}
                          onCheckedChange={() => onToggle?.(id)}
                          aria-label="Select row"
                        />
                      </TableCell>
                    )}
                    {columns.map((col) => (
                      <TableCell key={col.key} className={col.className}>
                        {renderCell(col, row)}
                      </TableCell>
                    ))}
                    {rowActions && (
                      <TableCell
                        className="text-right"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {rowActions(row)}
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        {/* Mobile: stacked cards */}
        <ul className={cn(sw.cards, "list-none")}>
          {rows.map((row) => {
            const id = getRowId(row);
            const { className: interactionClass, ...interaction } =
              rowInteraction(row);
            const buttonLike = !getRowHref?.(row) && onRowClick;
            return (
              <li key={id}>
                <Card
                  {...interaction}
                  role={buttonLike ? "button" : undefined}
                  className={cn(
                    "p-4 shadow-elevation-1",
                    isSelected(id) && "ring-2 ring-ring",
                    interactionClass,
                    interactionClass && "active:scale-[0.99]",
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      {selectable && (
                        <span
                          className="pt-0.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Checkbox
                            checked={isSelected(id)}
                            onCheckedChange={() => onToggle?.(id)}
                            aria-label="Select row"
                          />
                        </span>
                      )}
                      {primary && (
                        <div className="min-w-0 text-sm font-medium text-foreground">
                          {renderCell(primary, row)}
                        </div>
                      )}
                    </div>
                    {rowActions && (
                      <span
                        className="-mr-2 -mt-1 shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {rowActions(row)}
                      </span>
                    )}
                  </div>

                  {cardColumns.length > 0 && (
                    <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                      {cardColumns.map((col) => (
                        <React.Fragment key={col.key}>
                          <dt className="text-muted-foreground">
                            {col.cardLabel ?? col.header}
                          </dt>
                          <dd className="min-w-0 text-right text-foreground">
                            {renderCell(col, row)}
                          </dd>
                        </React.Fragment>
                      ))}
                    </dl>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      </>
    );
  }

  const showBulk = selectable && bulkBar && (selectedIds?.size ?? 0) > 0;

  return (
    <div className={cn(toolbar && "space-y-4", className)}>
      {toolbar}
      {body}
      {showBulk && bulkBar}
    </div>
  );
}

/** The #1527 name for the same primitive. */
export const DataTable = ResponsiveTable;
export type DataTableProps<T> = ResponsiveTableProps<T>;
export type DataTableColumn<T> = ResponsiveColumn<T>;
