"use client";

import { useMaintenanceState } from "@/providers/MaintenanceProvider";

/**
 * Hook to check if transactional operations (checkout, booking, event creation)
 * should be blocked during maintenance mode.
 *
 * Use this to disable submit buttons and show maintenance messages in forms.
 */
export function useMaintenanceGuard() {
  const { phase } = useMaintenanceState();

  return {
    /** True when any transactional operation should be blocked */
    isBlocked: phase === "DEGRADED" || phase === "OFFLINE",
    isDegraded: phase === "DEGRADED",
    isOffline: phase === "OFFLINE",
    /** User-facing message explaining why the action is blocked, or null if not blocked */
    blockReason:
      phase === "DEGRADED"
        ? "Bookings are temporarily paused during maintenance."
        : phase === "OFFLINE"
          ? "The platform is currently under maintenance."
          : null,
  };
}
