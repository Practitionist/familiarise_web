"use client";

import { SystemJobsPanel } from "@/components/dashboard/SystemJobsPanel";
import { PageHeader } from "@/components/ui/page-header";

export default function AdminSystemJobsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="System Jobs"
        description="Manually trigger background jobs for data validation and cleanup"
      />

      <SystemJobsPanel />
    </div>
  );
}
