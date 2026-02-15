"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

interface MaintenanceContextType {
  phase: string | null;
  reason: string | null;
  eta: string | null;
  isDismissed: boolean;
  dismiss: () => void;
}

const MaintenanceContext = createContext<MaintenanceContextType>({
  phase: null,
  reason: null,
  eta: null,
  isDismissed: false,
  dismiss: () => {},
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

  // Re-show banner on navigation
  useEffect(() => {
    setIsDismissed(false);
  }, []);

  // Poll health endpoint to pick up maintenance state
  useEffect(() => {
    const checkMaintenance = async () => {
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
    };

    checkMaintenance();
    const interval = setInterval(checkMaintenance, 60_000); // Check every 60s
    return () => clearInterval(interval);
  }, []);

  const dismiss = useCallback(() => setIsDismissed(true), []);

  const value = useMemo(
    () => ({ phase, reason, eta, isDismissed, dismiss }),
    [phase, reason, eta, isDismissed, dismiss],
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
