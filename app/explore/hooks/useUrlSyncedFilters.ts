"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ReadonlyParams } from "@/lib/explore/filter-codec";

const URL_SYNC_DEBOUNCE_MS = 300;

interface UseUrlSyncedFiltersOptions<T> {
  /** Pathname to write back to, e.g. "/explore/enterprise/organisations". */
  basePath: string;
  defaults: T;
  fromSearchParams: (params: ReadonlyParams) => T;
  toSearchParams: (filters: T) => string;
}

export interface UrlSyncedFilters<T> {
  filters: T;
  updateFilters: (partial: Partial<T>) => void;
  clearFilters: () => void;
}

/**
 * Filter state plus its URL mirror, generalised from `useExpertsFilters` so
 * every explore surface gets bookmarkable filters (programs previously synced
 * only `?tab=`).
 *
 * Two behaviours are carried over deliberately from the experts implementation:
 *
 * - `updateFilters` is SYNCHRONOUS. Consumers that fire rapid mutations (search
 *   typing, slider drags) debounce their own propagation; doing it here would
 *   make every consumer's query key lag behind the UI.
 * - URL writes go through `window.history.replaceState`, not `router.replace`.
 *   Next 15's App Router re-renders the tree via `useSearchParams` reactivity
 *   even with `{ scroll: false }`, which causes mid-typing scroll-to-top jumps.
 */
export function useUrlSyncedFilters<T>({
  basePath,
  defaults,
  fromSearchParams,
  toSearchParams,
}: UseUrlSyncedFiltersOptions<T>): UrlSyncedFilters<T> {
  const searchParams = useSearchParams();

  // Hydrate from the URL once so shareable links work. On the server
  // `searchParams` is empty in client components, so this falls back to
  // defaults during SSR and re-syncs on mount.
  const [filters, setFilters] = useState<T>(() =>
    fromSearchParams(searchParams),
  );

  const updateFilters = useCallback((partial: Partial<T>) => {
    setFilters((prev) => ({ ...prev, ...partial }));
  }, []);

  const clearFilters = useCallback(() => {
    setFilters(defaults);
    // `defaults` is a module-level constant at every call site; listing it
    // keeps the lint rule happy without changing identity across renders.
  }, [defaults]);

  const urlSyncRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (urlSyncRef.current) clearTimeout(urlSyncRef.current);
    urlSyncRef.current = setTimeout(() => {
      const qs = toSearchParams(filters);
      const target = `${basePath}${qs ? `?${qs}` : ""}`;
      const current = window.location.pathname + window.location.search;
      if (target !== current) {
        window.history.replaceState(window.history.state, "", target);
      }
    }, URL_SYNC_DEBOUNCE_MS);

    return () => {
      if (urlSyncRef.current) clearTimeout(urlSyncRef.current);
    };
  }, [filters, basePath, toSearchParams]);

  return { filters, updateFilters, clearFilters };
}
