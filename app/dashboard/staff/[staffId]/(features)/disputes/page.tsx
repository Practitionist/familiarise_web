"use client";

import { useParams } from "next/navigation";
import { DisputesPage } from "@/components/dashboard/shared/DisputesPage";

export default function StaffDisputesPage() {
  const params = useParams();
  const staffId = params.staffId as string;
  return (
    <DisputesPage
      basePath={`/dashboard/staff/${staffId}`}
      apiEndpoint="/api/admin/disputes"
      title="Disputes"
      description="View and track payment disputes"
    />
  );
}
