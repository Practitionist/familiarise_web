"use client";

import { DashboardContent } from "@/components/dashboard/PageScaffold";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { NotificationsSection } from "../sections/NotificationsSection";

/** /settings/notifications — the panel owns its own load and save cycle (#1785 L-2). */
export default function NotificationsSettingsPage() {
  return (
    <DashboardContent>
      <DashboardErrorBoundary>
        <NotificationsSection />
      </DashboardErrorBoundary>
    </DashboardContent>
  );
}
