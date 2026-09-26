"use client";

import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { NotificationPreferencesPanel } from "@/components/notifications";

/** Settings › Notifications — the panel owns its own load and save (#1527 §14). */
export default function ConsulteeNotificationsSettingsPage() {
  return (
    <DashboardErrorBoundary>
      <NotificationPreferencesPanel />
    </DashboardErrorBoundary>
  );
}
