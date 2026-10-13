import { Activity, CreditCard, Home } from "lucide-react";

import type { DashboardNav } from "./types";

/** Workspace Settings sections (#1527), one URL each under `/settings/<key>`. */
export const WORKSPACE_SETTINGS_SECTIONS = [
  {
    key: "landing",
    label: "Default landing organization",
    description: "Which organization opens when you sign in",
  },
  {
    key: "notifications",
    label: "Notification routing",
    description: "Where notifications from your organizations reach you",
  },
  {
    key: "account",
    label: "Account",
    description: "Sign-in security, sessions, and data privacy consent",
  },
] as const;

export type WorkspaceSettingsKey =
  (typeof WORKSPACE_SETTINGS_SECTIONS)[number]["key"];

export function workspaceSettingsGroups(orgWorkspaceId: string) {
  const base = `/dashboard/org-workspace/${orgWorkspaceId}/settings`;
  return [
    {
      title: "Workspace",
      sections: WORKSPACE_SETTINGS_SECTIONS.map((s) => ({
        key: s.key,
        label: s.label,
        description: s.description,
        href: `${base}/${s.key}`,
      })),
    },
  ];
}

/**
 * The "All organizations" facet (#1527 §7.4). "Spend" and "Workspace settings"
 * are named apart from the per-org Billing/Settings so the two scopes can't be
 * confused. Activity and Spend roll up the orgs the user OWNS; with one or
 * none they only repeat that org's own pages, so they are hidden.
 */
export function buildWorkspaceNav(
  orgWorkspaceId: string,
  { ownedOrgCount = 2 }: { ownedOrgCount?: number } = {},
): DashboardNav {
  const portfolio = ownedOrgCount > 1;
  const basePath = `/dashboard/org-workspace/${orgWorkspaceId}`;
  return {
    basePath,
    groups: [
      {
        items: [
          { name: "Overview", icon: Home, path: "home" },
          ...(portfolio
            ? [
                { name: "Activity", icon: Activity, path: "activity" },
                { name: "Spend", icon: CreditCard, path: "billing" },
              ]
            : []),
        ],
      },
    ],
    // The operator's Support requests page (#1527). It has no Feedback tab,
    // so the Help menu shows no Send feedback row.
    support: { requestsHref: `${basePath}/support`, feedbackHref: null },
    // #1527 — Workspace settings opens from the avatar menu.
    mobileTabs: portfolio ? ["home", "activity", "billing"] : ["home"],
  };
}

export const WORKSPACE_PAGE_LABELS: Record<string, string> = {
  home: "Overview",
  activity: "Activity",
  billing: "Spend",
  settings: "Workspace settings",
  landing: "Default landing organization",
  notifications: "Notification routing",
  account: "Account",
  support: "Support requests",
  create: "New organization",
};
