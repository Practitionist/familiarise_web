"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useDebouncedCallback } from "use-debounce";
import type { ProgramFilters, ProgramType } from "../utils";

const SEARCH_DEBOUNCE_MS = 300;

interface UseProgramsFiltersResult {
  // Tab — URL-synced via window.history.replaceState
  programType: ProgramType;
  handleTabChange: (tab: ProgramType) => void;

  // Server-side filters (drive React Query refetch)
  filters: ProgramFilters;
  updateFilters: (partial: Partial<ProgramFilters>) => void;

  // Client-side filters
  searchTerm: string; // debounced — fed into filterAndSortPrograms
  localSearchValue: string; // immediate — controls the input
  onLocalSearchChange: (value: string) => void;
  selectedLevel: string;
  setSelectedLevel: (level: string) => void;

  // View preference (purely cosmetic)
  viewMode: "grid" | "list";
  setViewMode: (mode: "grid" | "list") => void;

  clearAll: () => void;
}

/**
 * Owns all the local UI state for the programs listing page (tab, server
 * filters, client filters, view mode) plus the URL mirror for the active
 * tab.
 *
 * Mirrors the experts page's `useExpertsFilters` shape but encodes the
 * programs-specific filter type. URL writes go through
 * `window.history.replaceState` so we don't trigger the Next 15
 * `useSearchParams()` reactivity that caused scroll-to-top jumps on the
 * experts listing.
 *
 * Only the `tab` query param is URL-synced today (matching the original
 * behavior — topic / price / level filters were never bookmarkable).
 */
export function useProgramsFilters(): UseProgramsFiltersResult {
  const searchParams = useSearchParams();

  // Hydrate `programType` from `?tab=` once on mount.
  const [programType, setProgramType] = useState<ProgramType>(() => {
    const tab = searchParams.get("tab");
    return (tab as ProgramType) || "all";
  });

  const [filters, setFilters] = useState<ProgramFilters>({});

  // Search has both an immediate (input-controlled) and a debounced
  // (filter-applied) value. The debounced one feeds the client-side
  // filterAndSortPrograms, so rapid typing doesn't recompute the list
  // on every keystroke.
  const [searchTerm, setSearchTerm] = useState("");
  const [localSearchValue, setLocalSearchValue] = useState("");

  const [selectedLevel, setSelectedLevel] = useState("all");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  const debouncedSetSearch = useDebouncedCallback((value: string) => {
    setSearchTerm(value);
  }, SEARCH_DEBOUNCE_MS);

  const onLocalSearchChange = useCallback(
    (value: string) => {
      setLocalSearchValue(value);
      debouncedSetSearch(value);
    },
    [debouncedSetSearch],
  );

  const handleTabChange = useCallback((tab: ProgramType) => {
    setProgramType(tab);
    const params = new URLSearchParams(window.location.search);
    if (tab === "all") {
      params.delete("tab");
    } else {
      params.set("tab", tab);
    }
    const qs = params.toString();
    const target = `/explore/programs${qs ? `?${qs}` : ""}`;
    window.history.replaceState(window.history.state, "", target);
  }, []);

  const updateFilters = useCallback((partial: Partial<ProgramFilters>) => {
    setFilters((prev) => ({ ...prev, ...partial }));
  }, []);

  const clearAll = useCallback(() => {
    setFilters({});
    setSelectedLevel("all");
    setSearchTerm("");
    setLocalSearchValue("");
  }, []);

  // Cancel any pending debounced search call on unmount so we don't
  // setSearchTerm after the component is gone.
  useEffect(() => () => debouncedSetSearch.cancel(), [debouncedSetSearch]);

  return {
    programType,
    handleTabChange,
    filters,
    updateFilters,
    searchTerm,
    localSearchValue,
    onLocalSearchChange,
    selectedLevel,
    setSelectedLevel,
    viewMode,
    setViewMode,
    clearAll,
  };
}
