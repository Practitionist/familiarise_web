"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  DEFAULT_EXPERT_FILTERS,
  filtersFromSearchParams,
  filtersToSearchParams,
  type IExpertFilters,
} from "../utils";

const URL_SYNC_DEBOUNCE_MS = 300;

interface UseExpertsFiltersResult {
  filters: IExpertFilters;
  updateFilters: (partial: Partial<IExpertFilters>) => void;
  clearFilters: () => void;
}

/**
 * Owns the explore-experts filter state plus its URL mirror.
 *
 * - Hydrates `filters` from `useSearchParams` exactly once on mount so
 *   shareable links continue to work.
 * - All filter mutations go through `updateFilters` (partial merge) or
 *   `clearFilters`. The returned callbacks are stable across renders so
 *   memoized children don't re-render unnecessarily.
 * - The URL is a one-way mirror of `filters` (React state is the source
 *   of truth). We debounce URL syncs by 300 ms to coalesce rapid
 *   keystrokes / slider drags into a single history entry.
 * - URL writes go through `window.history.replaceState` rather than
 *   `router.replace`. Next.js 15's App Router still re-renders the
 *   whole tree via `useSearchParams` reactivity even with
 *   `{ scroll: false }`, which causes mid-typing scroll-to-top jumps.
 *   Bypassing the router avoids that.
 */
export function useExpertsFilters(): UseExpertsFiltersResult {
  const searchParams = useSearchParams();

  // Hydrate from URL once. The lazy initializer runs on both server and
  // client (server-side `searchParams` is empty / null in client components,
  // so this falls back to defaults during SSR and re-syncs on mount).
  const [filters, setFilters] = useState<IExpertFilters>(() =>
    filtersFromSearchParams(searchParams),
  );

  const updateFilters = useCallback((partial: Partial<IExpertFilters>) => {
    setFilters((prev) => ({ ...prev, ...partial }));
  }, []);

  const clearFilters = useCallback(() => {
    setFilters(DEFAULT_EXPERT_FILTERS);
  }, []);

  // Debounced URL sync via window.history.replaceState (see comment above).
  const urlSyncRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (urlSyncRef.current) clearTimeout(urlSyncRef.current);
    urlSyncRef.current = setTimeout(() => {
      const qs = filtersToSearchParams(filters);
      const target = `/explore/experts${qs ? `?${qs}` : ""}`;
      const current = window.location.pathname + window.location.search;
      if (target !== current) {
        window.history.replaceState(window.history.state, "", target);
      }
    }, URL_SYNC_DEBOUNCE_MS);

    return () => {
      if (urlSyncRef.current) clearTimeout(urlSyncRef.current);
    };
  }, [filters]);

  return { filters, updateFilters, clearFilters };
}
