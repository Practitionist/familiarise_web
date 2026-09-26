"use client";

/**
 * Back-office (admin / staff) adapter onto the shared DashboardShell (#1527).
 * The sidebar now hides below md like every other shell — it used to take a
 * fixed 256px on phones — and the mobile tabs + Menu sheet reach every item.
 *
 * Access is enforced upstream in the server layout; this component is chrome
 * only. Identity arrives as server-resolved props (no useSession first-render
 * null → no hydration mismatch on the displayed name).
 */

import { useMemo } from "react";
import { usePathname } from "next/navigation";
import { Settings, UserRound } from "lucide-react";

import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { ContextSwitcher } from "@/components/dashboard/ContextSwitcher";
import { useDashboardBreadcrumbs } from "@/components/dashboard/breadcrumbs";
import { usePrefetchNavPaths } from "@/hooks/usePrefetchNavPaths";
import { signOutEverywhere } from "@/lib/auth/sign-out";
import { flattenNav, type DashboardNav } from "@/lib/dashboard/nav/types";

export interface OperatorDashboardShellProps {
  nav: DashboardNav;
  /** Account chip role, e.g. "Admin" / "Staff". */
  roleLabel: string;
  userName: string | null;
  /** Accepted for the tree shells' identity pass-through; not displayed. */
  userEmail?: string | null;
  userImage: string | null;
  /** Routes to warm on mount (idle-scheduled). */
  prefetchPaths?: string[];
  children: React.ReactNode;
}

export function OperatorDashboardShell({
  nav,
  roleLabel,
  userName,
  userImage,
  prefetchPaths,
  children,
}: Readonly<OperatorDashboardShellProps>) {
  const pathname = usePathname() ?? "";
  usePrefetchNavPaths(prefetchPaths ?? []);

  // Crumb labels come from the nav itself: the last segment of each item
  // path maps to the item's name ("money/payments" → "Payments").
  const pageLabels = useMemo(() => {
    const labels: Record<string, string> = { money: "Money" };
    for (const item of flattenNav(nav)) {
      const segments = item.path.split("/");
      labels[segments[segments.length - 1]] = item.name;
    }
    return labels;
  }, [nav]);

  const breadcrumbs = useDashboardBreadcrumbs({
    pathname,
    basePath: nav.basePath,
    pageLabels,
  });

  const displayName = userName || "Operator";

  return (
    <DashboardShell
      kind="backoffice"
      nav={nav}
      switcher={<ContextSwitcher />}
      account={{
        name: displayName,
        image: userImage,
        roleLabel,
        // The operator's own profile page, not a platform surface.
        actions: [
          {
            label: "Settings",
            href: `${nav.basePath}/settings`,
            icon: Settings,
          },
        ],
      }}
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
