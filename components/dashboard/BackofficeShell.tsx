"use client";

/**
 * Single parameterized chrome for the admin + staff trees (Batch C2). The
 * tree is a `tree: "admin" | "staff"` argument, so the two surfaces cannot
 * drift apart. Per-tree differences (basePath, role label, prefetch, TDS
 * flag) are data, below.
 */

import { useMemo } from "react";

import {
  OperatorDashboardShell,
  type OperatorDashboardShellProps,
} from "@/components/dashboard/OperatorDashboardShell";
import { buildBackofficeDashboardNav } from "@/lib/dashboard/nav/backoffice";

export type BackofficeTree = "admin" | "staff";

interface BackofficeShellProps extends Pick<
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
  { roleLabel: string; prefetchSuffixes: [string, string] }
> = {
  admin: { roleLabel: "Admin", prefetchSuffixes: ["home", "money/payments"] },
  staff: { roleLabel: "Staff", prefetchSuffixes: ["home", "tickets"] },
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
  const nav = useMemo(
    () =>
      buildBackofficeDashboardNav(
        tree,
        basePath,
        tree === "admin" ? { showTds } : {},
      ),
    [tree, basePath, showTds],
  );

  return (
    <OperatorDashboardShell
      nav={nav}
      roleLabel={copy.roleLabel}
      userName={userName}
      userEmail={userEmail}
      userImage={userImage}
      prefetchPaths={copy.prefetchSuffixes.map((s) => `${basePath}/${s}`)}
    >
      {children}
    </OperatorDashboardShell>
  );
}
