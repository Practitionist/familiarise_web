"use client";

import { useParams } from "next/navigation";
import { SubscriptionsPage } from "@/components/dashboard/shared/SubscriptionsPage";

export default function StaffSubscriptionsPage() {
  const params = useParams();
  const staffId = params.staffId as string;
  return (
    <SubscriptionsPage
      basePath={`/dashboard/staff/${staffId}`}
      staffId={staffId}
      apiEndpoint="/api/admin/subscriptions"
      title="Subscriptions"
      description="View platform subscriptions (read-only)"
    />
  );
}
