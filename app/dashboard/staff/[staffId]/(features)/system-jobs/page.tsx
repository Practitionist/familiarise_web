"use client";

import { SystemJobsPanel } from "@/components/dashboard/SystemJobsPanel";

export default function StaffSystemJobsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">System Jobs</h1>
        <p className="text-gray-600 mt-1">
          Manually trigger background jobs for data validation and cleanup
        </p>
      </div>

      <SystemJobsPanel />
    </div>
  );
}
