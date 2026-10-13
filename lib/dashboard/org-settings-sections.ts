/**
 * Org Settings sections (#1527): one URL per section under
 * `/dashboard/organization/<id>/settings/<key>`, grouped for the shared
 * SettingsLayout. Each carries the gate its server routes use, so a role
 * never sees a section that 403s. MAINTAINER reads Security as status only;
 * every write and secret stays OWNER-only in the panels and routes. Keys are
 * the retired `?tab=` values, so old links map one to one. Pure: the shells,
 * Find and the section pages share it.
 */

import type { MemberRole } from "@prisma/client";

import { hasOrgPermission, type OrgSurface } from "@/lib/auth/org-permissions";

export type OrgSettingsKey =
  | "general"
  | "branding"
  | "sso"
  | "billing"
  | "webhooks"
  | "data-exports";

export interface OrgSettingsSection {
  key: OrgSettingsKey;
  group: "General" | "Security" | "Billing" | "Integrations";
  label: string;
  description: string;
  show: (can: (surface: OrgSurface) => boolean) => boolean;
}

export const ORG_SETTINGS_SECTIONS: readonly OrgSettingsSection[] = [
  {
    key: "general",
    group: "General",
    label: "General",
    description: "Organization profile and shape, and the cancellation policy",
    // GOVERNANCE (#1527 decision 7).
    show: (can) => can("settings.manage"),
  },
  {
    key: "branding",
    group: "General",
    label: "Branding",
    description: "Logo and colours on this organization's pages",
    show: (can) => can("settings.manage"),
  },
  {
    key: "sso",
    group: "Security",
    label: "Domains & SSO",
    description: "Verified email domains and single sign-on",
    // Reads are identity.read; claim/verify/SSO writes need identity.manage.
    show: (can) => can("identity.read"),
  },
  {
    key: "billing",
    group: "Billing",
    label: "Billing contacts",
    description: "Where invoices go and your payment terms",
    // `billing.manage`, not settings.manage: BILLING_ADMIN owns these two
    // fields (BILLING_ADMIN_FIELDS in the org PATCH route).
    show: (can) => can("billing.manage"),
  },
  {
    key: "webhooks",
    group: "Integrations",
    label: "Webhooks",
    description: "Events this organization sends to your systems",
    // #1527 §17b — OWNER + BILLING_ADMIN.
    show: (can) => can("integrations.manage"),
  },
  {
    key: "data-exports",
    group: "Integrations",
    label: "Data exports",
    description: "People and finance data bundles",
    // #1527 decision 4 — people (GOVERNANCE) or finance (OW + BA) bundles.
    show: (can) => can("dataExports.people") || can("dataExports.finance"),
  },
];

/** The sections a role may open, in nav order. */
export function orgSettingsSectionsFor(role: MemberRole): OrgSettingsSection[] {
  const can = (surface: OrgSurface) => hasOrgPermission(role, surface);
  return ORG_SETTINGS_SECTIONS.filter((s) => s.show(can));
}

/** Whether the avatar menu offers "<Org> settings" at all (#1527). */
export function canOpenOrgSettings(role: MemberRole): boolean {
  return orgSettingsSectionsFor(role).length > 0;
}

export function orgSettingsHref(orgId: string, key?: OrgSettingsKey): string {
  const base = `/dashboard/organization/${orgId}/settings`;
  return key ? `${base}/${key}` : base;
}

/** The sections grouped under their titles, for SettingsLayout and Find. */
export function orgSettingsGroups(
  orgId: string,
  role: MemberRole,
): {
  title: string;
  sections: { key: string; label: string; description: string; href: string }[];
}[] {
  const groups: ReturnType<typeof orgSettingsGroups> = [];
  for (const s of orgSettingsSectionsFor(role)) {
    const section = {
      key: s.key,
      label: s.label,
      description: s.description,
      href: orgSettingsHref(orgId, s.key),
    };
    const last = groups.at(-1);
    if (last?.title === s.group) last.sections.push(section);
    else groups.push({ title: s.group, sections: [section] });
  }
  return groups;
}

export function isOrgSettingsKey(
  value: string | undefined,
): value is OrgSettingsKey {
  return ORG_SETTINGS_SECTIONS.some((s) => s.key === value);
}

/** "<Org name> settings" for the avatar menu, the name capped (#1527). */
export function orgSettingsLabel(orgName: string, max = 28): string {
  const name = orgName.length > max ? `${orgName.slice(0, max - 1)}…` : orgName;
  return `${name} settings`;
}
