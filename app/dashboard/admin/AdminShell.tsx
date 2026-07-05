"use client";

/**
 * Client-side chrome for the admin dashboard. Sits inside the server-side
 * `layout.tsx`, which runs the `requireUserRole("ADMIN")` guard and resolves
 * the user identity props on the server — so access is enforced before any
 * markup ships to the client, and the sidebar's displayed name matches on the
 * server-rendered HTML and the first client render (no hydration mismatch and
 * no /api/user fetch waterfall).
 *
 * Chrome contract mirrors /dashboard/staff: a flat CollapsibleSidebar, a
 * sticky top bar carrying the OrganizationSwitcher + notification bell, and
 * the shared DashboardErrorBoundary around the page content.
 */

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  AlertTriangle,
  BadgeCheck,
  BarChart3,
  Building2,
  CreditCard,
  Home,
  ListChecks,
  Megaphone,
  Play,
  Receipt,
  RefreshCw,
  RotateCcw,
  Star,
  Ticket,
  Users,
  Wallet,
  Wrench,
} from "lucide-react";

import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import NovuProvider from "@/providers/NovuProvider";
import { NotificationInbox } from "@/components/notifications/NotificationInbox";
import { OrganizationSwitcher } from "@/components/dashboard/OrganizationSwitcher";
import { useNovuSubscriberSync } from "@/hooks/useNovuSubscriberSync";
import {
  CollapsibleSidebar,
  type CollapsibleSidebarItem,
} from "@/components/dashboard/CollapsibleSidebar";
import { signOutEverywhere } from "@/lib/auth/sign-out";
import { schedulePrefetch } from "@/lib/dashboard-queries";

// Navigation configuration for admin (flat list, mirrors staff sidebar layout)
const sidebarItems: CollapsibleSidebarItem[] = [
  { name: "Overview", icon: Home, path: "home" },
  { name: "Announcements", icon: Megaphone, path: "announcements" },
  { name: "Support Tickets", icon: Ticket, path: "tickets" },
  { name: "User Feedback", icon: Star, path: "feedback" },
  { name: "All Payments", icon: CreditCard, path: "payments" },
  { name: "Approval Payments", icon: BadgeCheck, path: "approval-payments" },
  { name: "Subscriptions", icon: RefreshCw, path: "subscriptions" },
  { name: "Refunds", icon: RotateCcw, path: "refunds" },
  { name: "Disputes", icon: AlertTriangle, path: "disputes" },
  { name: "Payouts", icon: Wallet, path: "payouts" },
  { name: "Invoices", icon: Receipt, path: "invoices" },
  { name: "Analytics", icon: BarChart3, path: "analytics" },
  { name: "Organizations", icon: Building2, path: "organizations" },
  { name: "Users", icon: Users, path: "users" },
  { name: "Waitlists", icon: ListChecks, path: "waitlists" },
  { name: "System Jobs", icon: Play, path: "system-jobs" },
  { name: "Maintenance", icon: Wrench, path: "maintenance" },
];

export function AdminShell({
  userName,
  userEmail,
  userImage,
  children,
}: {
  userName: string | null;
  userEmail: string | null;
  userImage: string | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  // Sync user as Novu subscriber (once per session)
  useNovuSubscriberSync();

  // Prefetch common routes
  useEffect(() => {
    schedulePrefetch(() => {
      router.prefetch("/dashboard/admin/home");
      router.prefetch("/dashboard/admin/payments");
    }, 3000);
  }, [router]);

  return (
    <NovuProvider>
      <div className="flex h-screen-maintenance bg-zinc-50 dark:bg-zinc-950">
        <CollapsibleSidebar
          items={sidebarItems}
          basePath="/dashboard/admin"
          title="Admin Portal"
          footerLabel="Familiarise Admin v1.0"
          avatarFallback="A"
          userName={userName || "Admin"}
          userEmail={userEmail ?? undefined}
          userImage={userImage}
          pathname={pathname}
          onSignOut={() => void signOutEverywhere()}
        />

        {/* Main Content */}
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
    </NovuProvider>
  );
}
