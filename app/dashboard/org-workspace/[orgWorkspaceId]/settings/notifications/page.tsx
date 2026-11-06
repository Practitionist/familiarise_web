import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { NotificationPreferencesPanel } from "@/components/notifications";

/** The operator's personal switches are the only notification channel control. */
export default function WorkspaceNotificationsSettingsPage() {
  return (
    <DashboardErrorBoundary>
      <NotificationPreferencesPanel />
    </DashboardErrorBoundary>
  );
}
