import { NotificationPreferencesPanel } from "@/components/notifications";
import { WorkspaceSettingsPage } from "../WorkspaceSettingsPage";

export default async function WorkspaceNotificationsSettingsPage({
  params,
}: Readonly<{ params: Promise<{ orgWorkspaceId: string }> }>) {
  const { orgWorkspaceId } = await params;
  return (
    <div className="space-y-6">
      <NotificationPreferencesPanel />
      <WorkspaceSettingsPage
        orgWorkspaceId={orgWorkspaceId}
        section="notifications"
      />
    </div>
  );
}
