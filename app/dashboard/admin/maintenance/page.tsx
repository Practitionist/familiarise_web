"use client";

import { useCallback, useEffect, useState } from "react";

interface MaintenanceState {
  phase: string;
  reason: string | null;
  estimatedEnd: string | null;
  bypassSecret: string | null;
}

interface MaintenanceWindow {
  id: string;
  phase: string;
  reason: string | null;
  startedAt: string | null;
  endedAt: string | null;
  estimatedEnd: string | null;
  startedBy: string | null;
  endedBy: string | null;
  createdAt: string;
}

export default function AdminMaintenancePage() {
  const [state, setState] = useState<MaintenanceState | null>(null);
  const [history, setHistory] = useState<MaintenanceWindow[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [bypassSecret, setBypassSecret] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [estimatedEnd, setEstimatedEnd] = useState("");

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/maintenance");
      if (!res.ok) return;
      const data = await res.json();
      setState(data.state);
      setHistory(data.history);
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchState();
  }, [fetchState]);

  const startMaintenance = async (phase: "DEGRADED" | "OFFLINE") => {
    setActionLoading(true);
    try {
      const res = await fetch("/api/admin/maintenance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phase,
          reason: reason || undefined,
          estimatedEnd: estimatedEnd || undefined,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setBypassSecret(data.bypassSecret);
        await fetchState();
      }
    } finally {
      setActionLoading(false);
    }
  };

  const updatePhase = async (phase: "DEGRADED" | "OFFLINE") => {
    setActionLoading(true);
    try {
      const res = await fetch("/api/admin/maintenance", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phase }),
      });
      if (res.ok) await fetchState();
    } finally {
      setActionLoading(false);
    }
  };

  const endMaintenance = async () => {
    setActionLoading(true);
    try {
      const res = await fetch("/api/admin/maintenance", { method: "DELETE" });
      if (res.ok) {
        setBypassSecret(null);
        await fetchState();
      }
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-gray-900" />
      </div>
    );
  }

  const isActive = state?.phase && state.phase !== "OFF";

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Maintenance Mode
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Control platform maintenance windows. Users will see a maintenance
          page (OFFLINE) or warning banner (DEGRADED).
        </p>
      </div>

      {/* Current Status */}
      <div className="rounded-lg border bg-card p-6">
        <h2 className="mb-4 text-lg font-medium">Current Status</h2>
        <div className="flex items-center gap-3">
          <StatusBadge phase={state?.phase || "OFF"} />
          {state?.reason && (
            <span className="text-sm text-muted-foreground">
              {state.reason}
            </span>
          )}
        </div>
        {state?.estimatedEnd && (
          <p className="mt-2 text-sm text-muted-foreground">
            ETA: {new Date(state.estimatedEnd).toLocaleString()}
          </p>
        )}
      </div>

      {/* Controls */}
      <div className="rounded-lg border bg-card p-6">
        <h2 className="mb-4 text-lg font-medium">Controls</h2>

        {!isActive ? (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium">
                  Reason (optional)
                </label>
                <input
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Database migration, deployment..."
                  className="w-full rounded-md border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">
                  Estimated End (optional)
                </label>
                <input
                  type="datetime-local"
                  value={estimatedEnd}
                  onChange={(e) => setEstimatedEnd(e.target.value)}
                  className="w-full rounded-md border px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => startMaintenance("DEGRADED")}
                disabled={actionLoading}
                className="rounded-md bg-yellow-500 px-4 py-2 text-sm font-medium text-white hover:bg-yellow-600 disabled:opacity-50"
              >
                Start Degraded Mode
              </button>
              <button
                onClick={() => startMaintenance("OFFLINE")}
                disabled={actionLoading}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                Start Offline Mode
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-3">
              {state?.phase === "DEGRADED" && (
                <button
                  onClick={() => updatePhase("OFFLINE")}
                  disabled={actionLoading}
                  className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  Escalate to Offline
                </button>
              )}
              {state?.phase === "OFFLINE" && (
                <button
                  onClick={() => updatePhase("DEGRADED")}
                  disabled={actionLoading}
                  className="rounded-md bg-yellow-500 px-4 py-2 text-sm font-medium text-white hover:bg-yellow-600 disabled:opacity-50"
                >
                  Downgrade to Degraded
                </button>
              )}
              <button
                onClick={endMaintenance}
                disabled={actionLoading}
                className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
              >
                End Maintenance
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Bypass Link */}
      {bypassSecret && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-6">
          <h2 className="mb-2 text-lg font-medium text-blue-900">
            Bypass Access
          </h2>
          <p className="mb-3 text-sm text-blue-700">
            Use this secret to bypass maintenance mode. Add as a cookie or
            header.
          </p>
          <code className="block rounded bg-blue-100 px-3 py-2 text-sm text-blue-900 break-all">
            {bypassSecret}
          </code>
          <p className="mt-2 text-xs text-blue-600">
            Header: <code>x-maintenance-bypass: {bypassSecret}</code> | Cookie:{" "}
            <code>maintenance_bypass={bypassSecret}</code>
          </p>
        </div>
      )}

      {/* History */}
      {history.length > 0 && (
        <div className="rounded-lg border bg-card p-6">
          <h2 className="mb-4 text-lg font-medium">History</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="pb-2 pr-4 font-medium">Phase</th>
                  <th className="pb-2 pr-4 font-medium">Reason</th>
                  <th className="pb-2 pr-4 font-medium">Started</th>
                  <th className="pb-2 pr-4 font-medium">Ended</th>
                </tr>
              </thead>
              <tbody>
                {history.map((window) => (
                  <tr key={window.id} className="border-b last:border-0">
                    <td className="py-2 pr-4">
                      <StatusBadge phase={window.phase} />
                    </td>
                    <td className="py-2 pr-4 text-muted-foreground">
                      {window.reason || "-"}
                    </td>
                    <td className="py-2 pr-4 text-muted-foreground">
                      {window.startedAt
                        ? new Date(window.startedAt).toLocaleString()
                        : "-"}
                    </td>
                    <td className="py-2 pr-4 text-muted-foreground">
                      {window.endedAt
                        ? new Date(window.endedAt).toLocaleString()
                        : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ phase }: { phase: string }) {
  const styles: Record<string, string> = {
    OFF: "bg-green-100 text-green-700",
    DEGRADED: "bg-yellow-100 text-yellow-700",
    OFFLINE: "bg-red-100 text-red-700",
  };

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${styles[phase] || styles.OFF}`}
    >
      {phase}
    </span>
  );
}
