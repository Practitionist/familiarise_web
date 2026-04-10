"use client";

import { DisputesPage } from "@/components/dashboard/shared/DisputesPage";

export default function AdminDisputesPage() {
  return (
    <DisputesPage
      basePath="/dashboard/admin"
      apiEndpoint="/api/admin/disputes"
      title="Disputes"
      description="Manage and respond to payment disputes"
    />
  );
}
