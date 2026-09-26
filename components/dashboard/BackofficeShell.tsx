"use client";

/**
 * Single parameterized chrome for the admin + staff trees (Batch C2).
 * AdminShell and StaffShell used to be near-identical wrappers around
 * OperatorDashboardShell with only string args differing — one tree was
 * always at risk of being the legacy one. There is now exactly one component:
 * the tree is a `tree: "admin" | "staff"` argument, so the two surfaces
 * cannot drift apart again. Per-tree differences (basePath, copy, prefetch,
 * TDS flag) are data, below.
 */

import { useMemo } from "react";
import { Settings } from "lucide-react";

import {
  OperatorDashboardShell,
  type OperatorDashboardShellProps,
} from "@/components/dashboard/OperatorDashboardShell";
import { buildBackofficeNav } from "@/lib/dashboard/backoffice-nav";

export type BackofficeTree = "admin" | "staff";

interface BackofficeShellProps
  extends Pick<
    OperatorDashboardShellProps,
    "userName" | "userEmail" | "userImage" | "children"
  > {
  tree: BackofficeTree;
  basePath: string;
  // #863 — the TDS surface is flag-gated (ENABLE_TDS_ADMIN_VIEW), read by the
  // server layout. The staff tree never shows TDS, so this is admin-only.
  showTds?: boolean;
}

const TREE_COPY: Record<
  BackofficeTree,
  {
    title: string;
    breadcrumbRoot: string;
    footerLabel: string;
    avatarFallback: string;
    chipRole: string;
    prefetchSuffixes: [string, string];
  }
> = {
  admin: {
    title: "Admin Portal",
    breadcrumbRoot: "Admin",
    footerLabel: "Familiarise Admin v1.0",
    avatarFallback: "A",
    chipRole: "Admin",
    prefetchSuffixes: ["home", "money/payments"],
  },
  staff: {
    title: "Staff Portal",
    breadcrumbRoot: "Staff",
    footerLabel: "Familiarise Staff v1.0",
    avatarFallback: "S",
    chipRole: "Staff",
    prefetchSuffixes: ["home", "tickets"],
  },
};

export function BackofficeShell({
  tree,
  basePath,
  userName,
  userEmail,
  userImage,
  children,
  showTds = false,
}: Readonly<BackofficeShellProps>) {
  const copy = TREE_COPY[tree];
  const groups = useMemo(
    () => buildBackofficeNav(tree, tree === "admin" ? { showTds } : {}),
    [tree, showTds],
  );

  return (
    <OperatorDashboardShell
      sidebarGroups={groups}
      basePath={basePath}
      title={copy.title}
      breadcrumbRoot={copy.breadcrumbRoot}
      footerLabel={copy.footerLabel}
      avatarFallback={copy.avatarFallback}
      userName={userName}
      userEmail={userEmail}
      userImage={userImage}
      bottomUserChipRole={copy.chipRole}
      bottomUserChipActions={[
        {
          type: "item",
          label: "Settings",
          href: `${basePath}/settings`,
          icon: Settings,
        },
      ]}
      prefetchPaths={copy.prefetchSuffixes.map((s) => `${basePath}/${s}`)}
    >
      {children}
    </OperatorDashboardShell>
  );
}
