"use client";

import MaintenanceControls from "@/components/dashboard/MaintenanceControls";

export default function StaffMaintenancePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          Maintenance Mode
        </h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Control platform maintenance windows. Users see a warning banner
          (degraded) or a full maintenance page (offline).
        </p>
      </div>
      <MaintenanceControls />
    </div>
  );
}
