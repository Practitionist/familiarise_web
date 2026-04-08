"use client";

import { RefundsPage } from "@/components/dashboard/shared/RefundsPage";

export default function StaffRefundsPage() {
  return (
    <RefundsPage
      basePath="/dashboard/admin"
      apiEndpoint="/api/admin/refunds"
      title="Refunds"
      description="View and track refund requests"
      queryKeyPrefix="staff-refunds"
    />
  );
}
