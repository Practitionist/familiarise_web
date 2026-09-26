"use client";

/**
 * Client-side chrome for the org-workspace ("All organizations") dashboard.
 * Sits inside the server layout that runs the IDOR guard and resolves the
 * identity props on the server, so the displayed name matches between the
 * server HTML and the first client render.
 *
 * Renders the shared DashboardShell (#1527); the switcher is where an
 * operator moves between this portfolio view and a single org.
 */

import { useMemo } from "react";
import { usePathname } from "next/navigation";
import { UserRound } from "lucide-react";

import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { ContextSwitcher } from "@/components/dashboard/ContextSwitcher";
import { useDashboardBreadcrumbs } from "@/components/dashboard/breadcrumbs";
import { usePrefetchNavPaths } from "@/hooks/usePrefetchNavPaths";
import { signOutEverywhere } from "@/lib/auth/sign-out";
import {
  buildWorkspaceNav,
  WORKSPACE_PAGE_LABELS,
} from "@/lib/dashboard/nav/workspace";

export function OrgWorkspaceShell({
  orgWorkspaceId,
  userName,
  userImage,
  children,
}: Readonly<{
  orgWorkspaceId: string;
  userName: string | null;
  userImage: string | null;
  children: React.ReactNode;
}>) {
  // usePathname() is URL-encoded while orgWorkspaceId (a route param) is
  // decoded; decode so basePath comparisons are like-for-like, and fall back
  // to the raw path on a malformed %-sequence rather than blanking the shell.
  const rawPathname = usePathname() ?? "";
  let pathname = rawPathname;
  try {
    pathname = decodeURIComponent(rawPathname);
  } catch {
    pathname = rawPathname;
  }
  const nav = useMemo(
    () => buildWorkspaceNav(orgWorkspaceId),
    [orgWorkspaceId],
  );

  // Overview + Activity + Spend are the operator's core loop.
  usePrefetchNavPaths([
    `${nav.basePath}/home`,
    `${nav.basePath}/activity`,
    `${nav.basePath}/billing`,
  ]);

  const breadcrumbs = useDashboardBreadcrumbs({
    pathname,
    basePath: nav.basePath,
    pageLabels: WORKSPACE_PAGE_LABELS,
  });

  const displayName = userName ?? "Operator";

  return (
    <DashboardShell
      kind="workspace"
      nav={nav}
      switcher={<ContextSwitcher />}
      account={{ name: displayName, image: userImage, roleLabel: "Operator" }}
      onSignOut={() => void signOutEverywhere()}
      contextBar={{
        identity: {
          name: displayName,
          image: userImage,
          FallbackIcon: UserRound,
        },
        breadcrumbs,
      }}
      pathname={pathname}
    >
      {children}
    </DashboardShell>
  );
}
