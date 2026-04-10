"use client";

import { SubscriptionsPage } from "@/components/dashboard/shared/SubscriptionsPage";

export default function AdminSubscriptionsPage() {
  return (
    <SubscriptionsPage
      apiEndpoint="/api/admin/subscriptions"
      title="Subscriptions"
      description="Manage platform subscription appointments"
    />
  );
}
