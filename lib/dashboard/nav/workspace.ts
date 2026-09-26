import { Activity, CreditCard, Home, Settings } from "lucide-react";

import type { DashboardNav } from "./types";

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
    settings: { name: "Workspace settings", icon: Settings, path: "settings" },
    // The workspace Support page is the operator's help desk (#1527 header).
    helpHref: `${basePath}/support`,
    mobileTabs: portfolio
      ? ["home", "activity", "billing", "settings"]
      : ["home", "settings"],
  };
}

export const WORKSPACE_PAGE_LABELS: Record<string, string> = {
  home: "Overview",
  activity: "Activity",
  billing: "Spend",
  settings: "Workspace settings",
  support: "Support",
  create: "New organization",
};
