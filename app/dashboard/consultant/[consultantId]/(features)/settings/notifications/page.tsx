import { DashboardContent } from "@/components/dashboard/PageScaffold";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { OwnerOnlySettingsNote } from "@/components/dashboard/OwnerOnlySettingsNote";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import { NotificationsSection } from "../sections/NotificationsSection";

/** /settings/notifications — the panel owns its own load and save cycle and its cards. */
export default async function NotificationsSettingsPage({
  params,
}: Readonly<{ params: Promise<{ consultantId: string }> }>) {
  const { consultantId } = await params;
  const access = await requirePersonalProfileAccess("consultant", consultantId);
  // The preferences are the signed-in viewer's own.
  if (access.isInspecting) {
    return <OwnerOnlySettingsNote title="Notifications" owner="expert" />;
  }
  return (
    <DashboardContent>
      <DashboardErrorBoundary>
        <NotificationsSection />
      </DashboardErrorBoundary>
    </DashboardContent>
  );
}
