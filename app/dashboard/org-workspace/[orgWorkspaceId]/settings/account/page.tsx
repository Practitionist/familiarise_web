import { AccountSettings } from "@/components/dashboard/account";

export default async function WorkspaceAccountSettingsPage({
  params,
}: Readonly<{ params: Promise<{ orgWorkspaceId: string }> }>) {
  const { orgWorkspaceId } = await params;
  return (
    <AccountSettings
      returnHref={`/dashboard/org-workspace/${orgWorkspaceId}/settings/account`}
    />
  );
}
