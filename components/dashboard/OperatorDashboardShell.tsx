"use client";

/**
 * Shared chrome for the operator-class dashboards (admin, staff) — the
 * cross-cutting internal surfaces that manage the whole platform rather
 * than one org or one personal account.
 *
 * Chrome contract matches the org / org-workspace flagship: a full
 * CollapsibleSidebar (which owns its own mobile drawer, since these trees
 * carry 16+ nav items and can't collapse to a bottom tab bar) plus a sticky
 * h-14 DashboardContextBar carrying the identity, a breadcrumb trail, and a
 * right slot (OrganizationSwitcher + notification bell). Page content is
 * wrapped in the shared DashboardErrorBoundary.
 *
 * Access is enforced upstream in the server layout; this component is chrome
 * only. Identity arrives as server-resolved props (no useSession first-render
 * null → no hydration mismatch on the displayed name).
 */

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { UserRound } from "lucide-react";

import NovuProvider from "@/providers/NovuProvider";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { DashboardContextBar } from "@/components/dashboard/DashboardContextBar";
import { NotificationInbox } from "@/components/notifications/NotificationInbox";
import { OrganizationSwitcher } from "@/components/dashboard/OrganizationSwitcher";
import { useNovuSubscriberSync } from "@/hooks/useNovuSubscriberSync";
import {
  CollapsibleSidebar,
  type CollapsibleSidebarItem,
} from "@/components/dashboard/CollapsibleSidebar";
import { signOutEverywhere } from "@/lib/auth/sign-out";
import { schedulePrefetch } from "@/lib/dashboard-queries";

/** Title-case a path segment for the breadcrumb when it isn't a nav item
 *  (e.g. a detail sub-route like `tickets/abc123`). */
function prettifySegment(segment: string): string {
  return segment
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export interface OperatorDashboardShellProps {
  /** Flat sidebar nav; item.name doubles as the breadcrumb label per path. */
  sidebarItems: CollapsibleSidebarItem[];
  /** e.g. "/dashboard/admin" or "/dashboard/staff/<id>". */
  basePath: string;
  /** Sidebar header title, e.g. "Admin Portal". */
  title: string;
  /** Root breadcrumb crumb, e.g. "Admin". */
  breadcrumbRoot: string;
  footerLabel?: string;
  avatarFallback: string;
  userName: string | null;
  userEmail: string | null;
  userImage: string | null;
  /** Routes to warm on mount (idle-scheduled). */
  prefetchPaths?: string[];
  children: React.ReactNode;
}

export function OperatorDashboardShell({
  sidebarItems,
  basePath,
  title,
  breadcrumbRoot,
  footerLabel,
  avatarFallback,
  userName,
  userEmail,
  userImage,
  prefetchPaths,
  children,
}: OperatorDashboardShellProps) {
  const pathname = usePathname() ?? "";
  const router = useRouter();

  // Sync user as Novu subscriber (once per session)
  useNovuSubscriberSync();

  const prefetchKey = prefetchPaths?.join("|") ?? "";
  useEffect(() => {
    if (!prefetchKey) return;
    const paths = prefetchKey.split("|");
    schedulePrefetch(() => {
      // router.prefetch warms the RSC payload; App Router dedupes.
      paths.forEach((p) => router.prefetch(p));
    }, 3000);
  }, [prefetchKey, router]);

  const displayName = userName || "Operator";

  // Active page label for the breadcrumb: the first segment after the base
  // path, mapped to its sidebar item name (or a prettified fallback for
  // detail sub-routes not present in the sidebar).
  const segment = pathname.slice(basePath.length).split("/").filter(Boolean)[0];
  const activeItem = sidebarItems.find((i) => i.path === segment);
  const pageLabel = activeItem
    ? activeItem.name
    : segment
      ? prettifySegment(segment)
      : (sidebarItems[0]?.name ?? "");

  return (
    <NovuProvider>
      <div className="flex h-screen-maintenance bg-background">
        <CollapsibleSidebar
          items={sidebarItems}
          basePath={basePath}
          title={title}
          footerLabel={footerLabel}
          avatarFallback={avatarFallback}
          userName={displayName}
          userEmail={userEmail ?? undefined}
          userImage={userImage}
          pathname={pathname}
          onSignOut={() => void signOutEverywhere()}
        />

        {/* Right panel: context bar + scrolling page content */}
        <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
          <DashboardContextBar
            identity={{
              name: displayName,
              image: userImage,
              FallbackIcon: UserRound,
            }}
            breadcrumbs={[breadcrumbRoot, pageLabel]}
            rightSlot={
              <div className="flex items-center gap-2">
                <OrganizationSwitcher />
                <NotificationInbox />
              </div>
            }
          />

          <main className="flex-1 overflow-y-auto">
            <div className="p-6">
              <DashboardErrorBoundary>{children}</DashboardErrorBoundary>
            </div>
          </main>
        </div>
      </div>
    </NovuProvider>
  );
}
