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
  const [phase, setPhase] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [eta, setEta] = useState<string | null>(null);
  const [isDismissed, setIsDismissed] = useState(false);
  const pathname = usePathname();

  // Re-show banner on navigation
  useEffect(() => {
    setIsDismissed(false);
  }, [pathname]);

  // Fetch maintenance state from health endpoint
  const checkMaintenance = useCallback(async () => {
    try {
      const res = await fetch("/api/health");
      const data = await res.json();
      const m = data.maintenance;
      if (m) {
        setPhase(m.phase === "OFF" ? null : m.phase);
        setReason(m.reason ?? null);
        setEta(m.estimatedEnd ?? null);
        // Re-show banner when state changes
        if (m.phase !== "OFF") setIsDismissed(false);
      }
    } catch {
      // Health check failed — don't disrupt the user
    }
  }, []);

  // Adaptive polling: 60s when maintenance is active, 5min when OFF
  useEffect(() => {
    checkMaintenance();
    const intervalMs = phase ? 60_000 : 300_000;
    const interval = setInterval(checkMaintenance, intervalMs);
    return () => clearInterval(interval);
  }, [checkMaintenance, phase]);

  const dismiss = useCallback(() => setIsDismissed(true), []);

  const value = useMemo(
    () => ({ phase, reason, eta, isDismissed, dismiss, refresh: checkMaintenance }),
    [phase, reason, eta, isDismissed, dismiss, checkMaintenance],
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
