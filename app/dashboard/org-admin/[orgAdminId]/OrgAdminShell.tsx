"use client";

/**
 * Client-side shell for the org-admin (operator) dashboard. Sits inside
 * the server-side layout that runs the IDOR guard and resolves the user
 * identity props on the server (so the sidebar's displayed name is
 * the same on the server-rendered HTML and the first client render —
 * no hydration mismatch).
 *
 * Renders the same CollapsibleSidebar pattern as /dashboard/admin and
 * /dashboard/staff, with a top context bar carrying OrganizationSwitcher
 * + NotificationInbox.
 *
 * Visual differentiation from the per-org dashboard:
 *   - Sidebar carries a silver/dark-grey gradient (via the new
 *     `className` prop on CollapsibleSidebar) — this is the agreed
 *     accent location, NOT the page background.
 *   - Sidebar subtitle reads "Cross-org dashboard" so the title +
 *     subtitle pair (Operator / Cross-org dashboard) names the scope.
 *   - Page body stays on flat zinc-50 — content cards keep their
 *     existing visual weight.
 *
 * Sidebar items are intentionally lean (Overview / Activity / Billing /
 * Settings). Per-org operator surfaces (members, programs, payouts) live
 * one level deeper at /dashboard/organization/[orgId]/* and have their
 * own sidebar — this dashboard is the *cross-org* operator view.
 */

import { usePathname } from "next/navigation";
import { Activity, CreditCard, Home, Settings } from "lucide-react";

import {
  CollapsibleSidebar,
  type CollapsibleSidebarItem,
} from "@/components/dashboard/CollapsibleSidebar";
import { OrganizationSwitcher } from "@/components/dashboard/OrganizationSwitcher";
import { NotificationInbox } from "@/components/notifications/NotificationInbox";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { signOut } from "@/lib/auth-client";
import { disconnectStreamClients } from "@/providers/StreamProvider";

const sidebarItems: CollapsibleSidebarItem[] = [
  { name: "Overview", icon: Home, path: "home" },
  { name: "Activity", icon: Activity, path: "activity" },
  { name: "Billing", icon: CreditCard, path: "billing" },
  { name: "Settings", icon: Settings, path: "settings" },
];

export function OrgAdminShell({
  orgAdminId,
  userName,
  userEmail,
  userImage,
  children,
}: {
  orgAdminId: string;
  userName: string | null;
  userEmail: string | null;
  userImage: string | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  const handleSignOut = async () => {
    try {
      await disconnectStreamClients();
    } catch {
      // Stream cleanup is best-effort.
    }
    signOut({
      fetchOptions: {
        onSuccess: () => {
          window.location.href = "/auth/signin";
        },
      },
    });
  };

  const displayName = userName ?? "Operator";
  const avatarFallback = displayName.charAt(0).toUpperCase();

  return (
    <div className="flex h-screen-maintenance bg-zinc-50 dark:bg-zinc-950">
      <CollapsibleSidebar
        items={sidebarItems}
        basePath={`/dashboard/org-admin/${orgAdminId}`}
        title="Operator"
        avatarFallback={avatarFallback}
        userName={displayName}
        userEmail={userEmail ?? undefined}
        userImage={userImage}
        userSubtitle="Cross-org dashboard"
        pathname={pathname}
        onSignOut={handleSignOut}
        // Jet-black sidebar accent — applied via the new className
        // prop on CollapsibleSidebar. The shared component's text +
        // icons are styled with `text-zinc-900 dark:text-zinc-100`
        // pairs, so we scope `dark` mode to this aside (Tailwind uses
        // class strategy per tailwind.config.ts:4) — every descendant's
        // `dark:*` variants kick in, flipping copy and icons to light
        // without affecting any other surface in the app.
        className="dark bg-gradient-to-b from-black via-zinc-900 to-black"
      />

      <main className="flex-1 overflow-y-auto">
        <div className="sticky top-0 z-30 flex items-center justify-end gap-2 px-6 py-2 border-b border-zinc-200/50 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-xl">
          <OrganizationSwitcher />
          <NotificationInbox />
        </div>
        <div className="p-6">
          <DashboardErrorBoundary>{children}</DashboardErrorBoundary>
        </div>
      </main>
    </div>
  );
}
