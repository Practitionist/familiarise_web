"use client";

import {
  FilterBar,
  type FilterBarProps,
  type FilterOption,
} from "@/components/dashboard/FilterBar";
import { Card, CardContent } from "@/components/ui/card";
import { useEffect } from "react";

export const GATEWAY_FILTER_OPTIONS: FilterOption[] = [
  { value: "all", label: "All Gateways" },
  { value: "STRIPE", label: "Stripe" },
  { value: "RAZORPAY", label: "Razorpay" },
];

interface PagedSelect {
  key: string;
  label: string;
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
}

interface PagedListFiltersInput {
  search: {
    label: string;
    placeholder: string;
    value: string;
    onChange: (value: string) => void;
  };
  /** Selects whose "no filter" value is `allValue`. */
  selects: PagedSelect[];
  setPage: (page: number) => void;
  /** The selects' "no filter" value; "all" unless the list's API uses another. */
  allValue?: string;
}

/** The Status select of a staff list, with "all" as its no-filter option. */
export function statusSelect(
  value: string,
  onChange: (value: string) => void,
  options: FilterOption[],
): PagedSelect {
  return {
    key: "status",
    label: "Status",
    value,
    onChange,
    options: [{ value: "all", label: "All Status" }, ...options],
  };
}

/** The payment-gateway select of a staff money list. */
export function gatewaySelect(
  value: string,
  onChange: (value: string) => void,
): PagedSelect {
  return {
    key: "gateway",
    label: "Gateway",
    value,
    onChange,
    options: GATEWAY_FILTER_OPTIONS,
  };
}

/**
 * FilterBar props for a paged staff list: any change returns to page 1, and
 * Clear empties the search and puts every select back on `allValue`.
 */
export function pagedListFilters({
  search,
  selects,
  setPage,
  allValue = "all",
}: PagedListFiltersInput): FilterBarProps {
  const toFirstPage =
    (set: (value: string) => void) =>
    (value: string): void => {
      set(value);
      setPage(1);
    };
  return {
    search: { ...search, onChange: toFirstPage(search.onChange) },
    selects: selects.map((s) => ({ ...s, onChange: toFirstPage(s.onChange) })),
    canClear:
      Boolean(search.value) || selects.some((s) => s.value !== allValue),
    onClear: () => {
      search.onChange("");
      for (const s of selects) s.onChange(allValue);
      setPage(1);
    },
  };
}

/** A paged staff list's filter row in its own card. */
export function PagedListFilterCard(props: Readonly<PagedListFiltersInput>) {
  return (
    <Card>
      <CardContent className="p-4">
        <FilterBar {...pagedListFilters(props)} />
      </CardContent>
    </Card>
  );
}

/**
 * `placeholderData` that keeps the previous rows only while the page alone
 * changes; a filter change shows the loading state, never the old rows and total.
 */
export function keepPreviousPageOnly<T>(
  queryKey: readonly unknown[],
  pageIndex: number,
) {
  return (
    previous: T | undefined,
    previousQuery: { queryKey: readonly unknown[] } | undefined,
  ): T | undefined =>
    previousQuery?.queryKey.length === queryKey.length &&
    previousQuery.queryKey.every(
      (part, i) => i === pageIndex || Object.is(part, queryKey[i]),
    )
      ? previous
      : undefined;
}

/**
 * Moves a pager back to the list's last page when the list shrank under it
 * (the last row of a page was resolved or deleted), so the page never reads
 * as empty while rows remain. Pass `total` only from this page's own answer:
 * undefined while it loads or while a placeholder shows the previous page's.
 */
export function usePageWithinTotal(
  page: number,
  setPage: (page: number) => void,
  total: number | undefined,
  pageSize: number,
): void {
  useEffect(() => {
    if (total === undefined) return;
    const last = Math.max(1, Math.ceil(total / pageSize));
    if (page > last) setPage(last);
  }, [page, setPage, total, pageSize]);
}
