import { Activity, CreditCard, Home, LifeBuoy, Settings } from "lucide-react";

import type { DashboardNav } from "./types";

/**
 * The "All organizations" facet (#1527 §7.4). "Spend" and "Workspace settings"
 * are named apart from the per-org Billing/Settings so the two scopes can't be
 * confused.
 */
export function buildWorkspaceNav(orgWorkspaceId: string): DashboardNav {
  return {
    basePath: `/dashboard/org-workspace/${orgWorkspaceId}`,
    groups: [
      {
        items: [
          { name: "Overview", icon: Home, path: "home" },
          { name: "Activity", icon: Activity, path: "activity" },
          { name: "Spend", icon: CreditCard, path: "billing" },
          { name: "Workspace settings", icon: Settings, path: "settings" },
          { name: "Support", icon: LifeBuoy, path: "support" },
        ],
      },
    ],
    utility: [],
    mobileTabs: ["home", "activity", "billing", "support"],
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
