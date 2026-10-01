"use client";

import { DashboardContent } from "@/components/dashboard/PageScaffold";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { Card, CardContent } from "@/components/ui/card";
import { NotificationsSection } from "../sections/NotificationsSection";

/** /settings/notifications — the panel owns its own load and save cycle (#1785 L-2). */
export default function NotificationsSettingsPage() {
  return (
    <DashboardContent>
      <DashboardErrorBoundary>
        <Card>
          <CardContent className="p-6">
            <NotificationsSection />
          </CardContent>
        </Card>
      </DashboardErrorBoundary>
    </DashboardContent>
  );
}
