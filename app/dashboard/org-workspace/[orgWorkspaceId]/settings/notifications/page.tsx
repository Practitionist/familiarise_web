import { WorkspaceSettingsPage } from "../WorkspaceSettingsPage";

export default async function WorkspaceNotificationsSettingsPage({
  params,
}: Readonly<{ params: Promise<{ orgWorkspaceId: string }> }>) {
  const { orgWorkspaceId } = await params;
  return (
    <WorkspaceSettingsPage
      orgWorkspaceId={orgWorkspaceId}
      section="notifications"
    />
  );
}
