"use client";

import { SubscriptionsPage } from "@/components/dashboard/shared/SubscriptionsPage";

export default function StaffSubscriptionsPage() {
  return (
    <SubscriptionsPage
      apiEndpoint="/api/admin/subscriptions"
      title="Subscriptions"
      description="View platform subscriptions (read-only)"
    />
  );
}
