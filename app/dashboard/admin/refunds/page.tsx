"use client";

import { RefundsPage } from "@/components/dashboard/shared/RefundsPage";

export default function AdminRefundsPage() {
  return (
    <RefundsPage
      basePath="/dashboard/admin"
      apiEndpoint="/api/admin/refunds"
      title="Refunds"
      description="Manage and view all payment refunds"
      queryKeyPrefix="admin-refunds"
    />
  );
}
