"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { usePathname } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";

interface HealthResponse {
  maintenance?: {
    phase: string;
    reason?: string | null;
    estimatedEnd?: string | null;
  } | null;
}

// Cached under ["health"] (stale 5min) so every mount doesn't hit /api/health;
// the poll below only runs while maintenance is actually ON.
async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch("/api/health");
  return res.json();
}

interface MaintenanceContextType {
  phase: string | null;
  reason: string | null;
  eta: string | null;
  isDismissed: boolean;
  dismiss: () => void;
  /** Trigger an immediate re-fetch of maintenance state from /api/health */
  refresh: () => Promise<void>;
}

const MaintenanceContext = createContext<MaintenanceContextType>({
  phase: null,
  reason: null,
  eta: null,
  isDismissed: false,
  dismiss: () => {},
  refresh: async () => {},
});

export function MaintenanceProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [isDismissed, setIsDismissed] = useState(false);
  const pathname = usePathname();
  const queryClient = useQueryClient();

  // Single cached health read: stale 5min, and the 60s poll only runs while
  // maintenance is ON. A failed poll keeps the last good data and never
  // disrupts the user — same as the old swallowed catch.
  const { data } = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    staleTime: 5 * 60_000,
    // In v5 the function form receives the Query, not the data — read the
    // phase off query.state.data.
    refetchInterval: (query) => {
      const current = query.state.data?.maintenance?.phase;
      return current && current !== "OFF" ? 60_000 : false;
    },
    retry: false,
    refetchOnWindowFocus: false,
  });

  const maintenance = data?.maintenance ?? null;
  const phase =
    maintenance && maintenance.phase !== "OFF" ? maintenance.phase : null;
  const reason = maintenance?.reason ?? null;
  const eta = maintenance?.estimatedEnd ?? null;

  // Re-show banner on navigation
  useEffect(() => {
    setIsDismissed(false);
  }, [pathname]);

  // Re-show banner when maintenance turns on
  useEffect(() => {
    if (phase) setIsDismissed(false);
  }, [phase]);

  const dismiss = useCallback(() => setIsDismissed(true), []);

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["health"] });
  }, [queryClient]);

  const value = useMemo(
    () => ({
      phase,
      reason,
      eta,
      isDismissed,
      dismiss,
      refresh,
    }),
    [phase, reason, eta, isDismissed, dismiss, refresh],
  );

  return (
    <MaintenanceContext.Provider value={value}>
      {children}
    </MaintenanceContext.Provider>
  );
}

export function useMaintenanceState() {
  return useContext(MaintenanceContext);
}
