import { notFound } from "next/navigation";

import { requireOrgAccess } from "@/lib/auth-helpers";

import { SettingsTabs } from "./SettingsTabs";

/**
 * /dashboard/organization/[orgId]/settings — org config, SSO, integrations.
 *
 * Floors at active membership rather than `settings.manage`, because the tabs
 * behind it answer to different grants (GOVERNANCE, OWNER, `billing.manage`,
 * `integrations.manage`) and "Your notifications" is every member's. Each tab
 * enforces its own gate (SettingsTabs.tsx).
 */
export default async function OrgSettingsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  const access = await requireOrgAccess(orgId);
  if (access.error) {
    notFound();
  }

  return <SettingsTabs orgId={orgId} />;
}
