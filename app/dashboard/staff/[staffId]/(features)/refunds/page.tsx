"use client";

import { useParams } from "next/navigation";
import { RefundsPage } from "@/components/dashboard/shared/RefundsPage";

export default function StaffRefundsPage() {
  const params = useParams();
  const staffId = params.staffId as string;
  return (
    <RefundsPage
      basePath={`/dashboard/staff/${staffId}`}
      apiEndpoint="/api/admin/refunds"
      title="Refunds"
      description="View and track refund requests"
      queryKeyPrefix="staff-refunds"
    />
  );
}
