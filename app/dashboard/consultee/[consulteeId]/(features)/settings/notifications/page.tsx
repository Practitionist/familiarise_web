import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { OwnerOnlySettingsNote } from "@/components/dashboard/OwnerOnlySettingsNote";
import { NotificationPreferencesPanel } from "@/components/notifications";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";

/** Settings › Notifications — the panel owns its own load and save (#1527 §14). */
export default async function ConsulteeNotificationsSettingsPage({
  params,
}: Readonly<{ params: Promise<{ consulteeId: string }> }>) {
  const { consulteeId } = await params;
  const access = await requirePersonalProfileAccess("consultee", consulteeId);
  // The preferences are the signed-in viewer's own.
  if (access.isInspecting) {
    return <OwnerOnlySettingsNote title="Notifications" owner="learner" />;
  }
  return (
    <DashboardErrorBoundary>
      <NotificationPreferencesPanel />
    </DashboardErrorBoundary>
  );
}
