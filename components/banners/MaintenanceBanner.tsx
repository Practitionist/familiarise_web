"use client";

import { useMaintenanceState } from "@/providers/MaintenanceProvider";

export default function MaintenanceBanner() {
  const { phase, reason, eta, isDismissed, dismiss } = useMaintenanceState();

  if (!phase || phase === "OFF" || isDismissed) return null;

  return (
    <div className="relative z-50 bg-yellow-50 border-b border-yellow-200 px-4 py-2.5 text-center text-sm text-yellow-800">
      <div className="mx-auto flex max-w-5xl items-center justify-center gap-2">
        <svg
          className="h-4 w-4 flex-shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
          />
        </svg>
        <span>
          <span className="font-medium">Scheduled maintenance:</span>{" "}
          {reason || "Some features may be temporarily unavailable."}
          {eta && (
            <span className="ml-1 text-yellow-700">
              Expected completion: {formatEta(eta)}
            </span>
          )}
        </span>
        <button
          onClick={dismiss}
          className="ml-2 flex-shrink-0 rounded p-0.5 text-yellow-600 hover:bg-yellow-100 hover:text-yellow-800"
          aria-label="Dismiss maintenance notice"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function formatEta(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return isoString;
  }
}
