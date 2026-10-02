import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";

import { requireOrgAccess } from "@/lib/auth-helpers";
import {
  isOrgSettingsKey,
  orgSettingsSectionsFor,
  type OrgSettingsKey,
} from "@/lib/dashboard/org-settings-sections";

import { BillingSettingsPanel } from "../BillingSettingsPanel";
import { BrandingPanel } from "../BrandingPanel";
import { DataExportsPanel } from "../DataExportsPanel";
import { DomainsPanel } from "../DomainsPanel";
import { GeneralPanel } from "../GeneralPanel";
import { SsoPanel } from "../SsoPanel";
import { WebhooksPanel } from "../WebhooksPanel";

const PANELS: Record<OrgSettingsKey, (orgId: string) => ReactNode> = {
  general: (orgId) => <GeneralPanel orgId={orgId} />,
  branding: (orgId) => <BrandingPanel orgId={orgId} />,
  sso: (orgId) => (
    <div className="space-y-6">
      <DomainsPanel orgId={orgId} />
      <SsoPanel orgId={orgId} />
    </div>
  ),
  billing: (orgId) => <BillingSettingsPanel orgId={orgId} />,
  webhooks: (orgId) => <WebhooksPanel orgId={orgId} />,
  "data-exports": (orgId) => <DataExportsPanel orgId={orgId} />,
};

/**
 * One org Settings section (#1527). The gate is the section's own matrix
 * key; a role without it is sent Home, as the other org page gates do.
 */
export default async function OrgSettingsSectionPage({
  params,
}: Readonly<{ params: Promise<{ orgId: string; section: string }> }>) {
  const { orgId, section } = await params;
  if (!isOrgSettingsKey(section)) notFound();
  const access = await requireOrgAccess(orgId);
  if (access.error) notFound();
  const allowed = orgSettingsSectionsFor(access.member.role).some(
    (s) => s.key === section,
  );
  if (!allowed) redirect(`/dashboard/organization/${orgId}/home`);

  return PANELS[section](orgId);
}
