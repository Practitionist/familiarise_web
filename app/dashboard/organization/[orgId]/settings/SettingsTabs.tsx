"use client";

/**
 * Org Settings (#1527 §14): General · Branding · Domains & SSO · Directory
 * sync · Billing contacts · Webhooks · Data exports · Your notifications.
 *
 * Each tab carries the gate its server routes use, so a role never sees a tab
 * that 403s: General and Branding are `settings.manage` (GOVERNANCE, #1527
 * decision 7); Domains & SSO and Directory sync are `identity.read` —
 * MAINTAINER reads status, every write and secret stays OWNER-only in the
 * panels and routes; Billing contacts is `billing.manage`; Data exports is
 * either `dataExports.*` kind; Webhooks is `integrations.manage` (OWNER +
 * BILLING_ADMIN, §17b). Tab values keep the old `?tab=` names so bookmarks
 * still land.
 */

import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import { UrlTabs, type UrlTab } from "@/components/dashboard/UrlTabs";
import { hasOrgPermission } from "@/lib/auth/org-permissions";

import { useOrgRole } from "../useOrgRole";
import { GeneralPanel } from "./GeneralPanel";
import { BillingSettingsPanel } from "./BillingSettingsPanel";
import { SsoPanel } from "./SsoPanel";
import { WebhooksPanel } from "./WebhooksPanel";
import { ScimPanel } from "./ScimPanel";
import { DataExportsPanel } from "./DataExportsPanel";
import { BrandingPanel } from "./BrandingPanel";
import { DomainsPanel } from "./DomainsPanel";
import { NotificationPreferencesPanel } from "@/components/notifications/NotificationPreferencesPanel";

export function SettingsTabs({ orgId }: { orgId: string }) {
  const { role, isLoading } = useOrgRole(orgId);

  // useOrgRole defaults to LEARNER while loading, which would flash a
  // single-tab bar and then expand. Hold until the role resolves.
  if (isLoading) return null;

  const can = hasOrgPermission.bind(null, role);

  const tabs: UrlTab[] = [
    {
      value: "general",
      label: "General",
      content: <GeneralPanel orgId={orgId} />,
      show: can("settings.manage"),
    },
    {
      value: "branding",
      label: "Branding",
      content: <BrandingPanel orgId={orgId} />,
      show: can("settings.manage"),
    },
    {
      value: "sso",
      label: "Domains & SSO",
      content: (
        <>
          <DomainsPanel orgId={orgId} />
          <SsoPanel orgId={orgId} />
        </>
      ),
      // Reads are identity.read; claim/verify/SSO writes stay requireOrgOwner.
      show: can("identity.read"),
    },
    {
      value: "scim",
      label: "Directory sync",
      content: <ScimPanel orgId={orgId} />,
      // Token/mapping reads are identity.read; writes stay requireOrgOwner.
      show: can("identity.read"),
    },
    {
      value: "billing",
      label: "Billing contacts",
      content: <BillingSettingsPanel orgId={orgId} />,
      // `billing.manage` (OWNER + BILLING_ADMIN), not `settings.manage`. The
      // server has always let BILLING_ADMIN write these two fields — see
      // BILLING_ADMIN_FIELDS in the org PATCH route — but the only UI for them
      // sat on General behind GOVERNANCE, so the finance role could not reach
      // the billing email it owns.
      show: can("billing.manage"),
    },
    {
      value: "webhooks",
      label: "Webhooks",
      content: <WebhooksPanel orgId={orgId} />,
      show: can("integrations.manage"),
    },
    {
      value: "data-exports",
      label: "Data exports",
      content: <DataExportsPanel orgId={orgId} />,
      // #1527 decision 4 — people (GOVERNANCE) or finance (OW + BA) bundles.
      show: can("dataExports.people") || can("dataExports.finance"),
    },
    {
      // ADR 23 — the org dashboard carried a notification bell but no way to
      // configure it, and no org category existed at all, so the whole ORG_*
      // family was unmutable. Deliberately ungated: this configures the
      // VIEWER's own delivery, not org config, so it needs no matrix key and
      // every active member reaches it — the same floor as Appointments and
      // Messages. The preferences themselves are per-user, not per-org, which
      // is why the panel is the same one the personal dashboards mount.
      value: "notifications",
      // The viewer's own delivery preferences, not the org's (#1527).
      label: "Your notifications",
      content: <NotificationPreferencesPanel />,
    },
  ];

  return (
    <>
      <DashboardHeader
        title="Settings"
        description="Organization profile, sign-in, integrations and your own notifications."
      />
      <DashboardContent>
        <UrlTabs tabs={tabs} />
      </DashboardContent>
    </>
  );
}
