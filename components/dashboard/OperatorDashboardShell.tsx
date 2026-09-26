"use client";

/**
 * Back-office (admin / staff) adapter onto the shared DashboardShell (#1527).
 * The sidebar now hides below md like every other shell — it used to take a
 * fixed 256px on phones — and the mobile tabs + Menu sheet reach every item.
 *
 * Access is enforced upstream in the server layout; this component is chrome
 * only. The nav and role label come from the capability context the layout
 * provides; identity arrives as server-resolved props (no useSession
 * first-render null → no hydration mismatch on the displayed name).
 */

import { useMemo } from "react";
import { usePathname } from "next/navigation";
import { Settings, UserRound } from "lucide-react";

import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { ContextSwitcher } from "@/components/dashboard/ContextSwitcher";
import { useDashboardBreadcrumbs } from "@/components/dashboard/breadcrumbs";
import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { usePrefetchNavPaths } from "@/hooks/usePrefetchNavPaths";
import { signOutEverywhere } from "@/lib/auth/sign-out";
import { backofficeLandingHref } from "@/lib/backoffice/capability";
import { buildBackofficeDashboardNav } from "@/lib/dashboard/nav/backoffice";
import { flattenNav } from "@/lib/dashboard/nav/types";

export interface OperatorDashboardShellProps {
  userName: string | null;
  userImage: string | null;
  /** #863 — ENABLE_TDS_ADMIN_VIEW, read by the server layout. */
  showTds?: boolean;
  children: React.ReactNode;
}

export function OperatorDashboardShell({
  userName,
  userImage,
  showTds = false,
  children,
}: Readonly<OperatorDashboardShellProps>) {
  const cap = useBackofficeCapability();
  const nav = useMemo(
    () => buildBackofficeDashboardNav(cap, { showTds }),
    [cap, showTds],
  );
  const roleLabel = cap.tree === "admin" ? "Admin" : "Staff";
  const prefetchPaths = useMemo(
    () => [
      backofficeLandingHref(cap),
      ...nav.mobileTabs.map((p) => `${nav.basePath}/${p}`),
    ],
    [cap, nav],
  );
  const pathname = usePathname() ?? "";
  usePrefetchNavPaths(prefetchPaths);

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
