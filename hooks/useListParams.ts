"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";

export interface ListSort {
  key: string;
  dir: "asc" | "desc";
}

export interface ListParams<F extends string> {
  q: string;
  /** 1-based. */
  page: number;
  sort: ListSort | null;
  filters: Record<F, string | null>;
}

export interface ListParamsPatch<F extends string> {
  q?: string;
  page?: number;
  sort?: ListSort | null;
  filters?: Partial<Record<F, string | null>>;
}

/** `sort=createdAt` is ascending, `sort=-createdAt` descending. */
function encodeSort(sort: ListSort): string {
  return sort.dir === "desc" ? `-${sort.key}` : sort.key;
}

function decodeSort(raw: string | null): ListSort | null {
  if (!raw) return null;
  return raw.startsWith("-")
    ? { key: raw.slice(1), dir: "desc" }
    : { key: raw, dir: "asc" };
}

export function readListParams<F extends string>(
  get: (key: string) => string | null,
  filterKeys: readonly F[],
  defaultSort: ListSort | null = null,
): ListParams<F> {
  const page = Number.parseInt(get("page") ?? "1", 10);
  const filters = {} as Record<F, string | null>;
  for (const key of filterKeys) filters[key] = get(key) || null;
  return {
    q: get("q") ?? "",
    page: Number.isFinite(page) && page >= 1 ? page : 1,
    sort: decodeSort(get("sort")) ?? defaultSort,
    filters,
  };
}

/**
 * The next search string after a list change. Any change other than the page
 * itself goes back to page 1; defaults (page 1, empty search, the default
 * sort, a cleared filter) are removed rather than written. Other keys pass
 * through untouched.
 */
export function nextListSearch<F extends string>(
  current: string,
  patch: ListParamsPatch<F>,
  defaultSort: ListSort | null = null,
): string {
  const next = new URLSearchParams(current);
  const apply = (key: string, value: string | null) => {
    if (value === null || value === "") next.delete(key);
    else next.set(key, value);
  };
  let reset = false;
  if (patch.q !== undefined) {
    apply("q", patch.q.trim());
    reset = true;
  }
  if (patch.sort !== undefined) {
    const same =
      patch.sort === null ||
      (defaultSort !== null &&
        patch.sort.key === defaultSort.key &&
        patch.sort.dir === defaultSort.dir);
    apply("sort", same || !patch.sort ? null : encodeSort(patch.sort));
    reset = true;
  }
  for (const [key, value] of Object.entries(patch.filters ?? {})) {
    apply(key, (value as string | null | undefined) ?? null);
    reset = true;
  }
  if (patch.page !== undefined) {
    apply("page", patch.page <= 1 ? null : String(patch.page));
  } else if (reset) {
    apply("page", null);
  }
  return next.toString();
}

/**
 * URL-synced list state `{ q, page, sort, filters }` for dashboard lists
 * (#1527), generalised from the Requests inbox. Writes go through the native
 * history API, which the App Router syncs into `useSearchParams`: the URL
 * changes synchronously and a filter click causes no server round trip
 * (QA #1783 case 3 — `router.replace` left the URL behind).
 *
 * Put the returned params in the react-query key and keep
 * `placeholderData: keepPreviousData` on that query.
 */
export function useListParams<F extends string = never>(
  opts: { filterKeys?: readonly F[]; defaultSort?: ListSort | null } = {},
) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filterKeyList = (opts.filterKeys ?? []).join(",");
  const sortKey = opts.defaultSort?.key;
  const sortDir = opts.defaultSort?.dir;

  const defaultSort = useMemo<ListSort | null>(
    () => (sortKey && sortDir ? { key: sortKey, dir: sortDir } : null),
    [sortKey, sortDir],
  );

  const params = useMemo(
    () =>
      readListParams(
        (key) => searchParams.get(key),
        (filterKeyList ? filterKeyList.split(",") : []) as F[],
        defaultSort,
      ),
    [searchParams, filterKeyList, defaultSort],
  );

  const setParams = useCallback(
    (patch: ListParamsPatch<F>) => {
      const qs = nextListSearch(searchParams.toString(), patch, defaultSort);
      window.history.replaceState(
        window.history.state,
        "",
        qs ? `${pathname}?${qs}` : pathname,
      );
    },
    [pathname, searchParams, defaultSort],
  );

  return {
    ...params,
    setParams,
    setQ: (q: string) => setParams({ q }),
    setPage: (page: number) => setParams({ page }),
    setSort: (sort: ListSort | null) => setParams({ sort }),
    setFilter: (key: F, value: string | null) =>
      setParams({
        filters: { [key]: value } as Partial<Record<F, string | null>>,
      }),
    clear: () =>
      setParams({
        q: "",
        sort: null,
        filters: Object.fromEntries(
          (filterKeyList ? filterKeyList.split(",") : []).map((k) => [k, null]),
        ) as Partial<Record<F, string | null>>,
      }),
  };
}
