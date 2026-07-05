"use client";

/**
 * Client-side chrome for the staff dashboard. Sits inside the server-side
 * `layout.tsx`, which enforces the staff-access rule and resolves the user
 * identity props on the server — so access is decided before any markup
 * ships to the client, and the sidebar's displayed name matches on the
 * server HTML and the first client render (no hydration mismatch, no
 * fetchUserDetails waterfall).
 *
 * Chrome contract mirrors /dashboard/admin: a flat CollapsibleSidebar, a
 * sticky top bar with the OrganizationSwitcher + notification bell, and the
 * shared DashboardErrorBoundary around the page content.
 */

import {
  AlertTriangle,
  BarChart3,
  Calendar,
  Clock,
  CreditCard,
  Home,
  Megaphone,
  Receipt,
  RefreshCw,
  RotateCcw,
  Settings,
  Shield,
  Star,
  Ticket,
  Users,
  Wallet,
} from "lucide-react";
import { usePathname } from "next/navigation";

import NovuProvider from "@/providers/NovuProvider";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { NotificationInbox } from "@/components/notifications/NotificationInbox";
import { OrganizationSwitcher } from "@/components/dashboard/OrganizationSwitcher";
import { useNovuSubscriberSync } from "@/hooks/useNovuSubscriberSync";
import {
  CollapsibleSidebar,
  type CollapsibleSidebarItem,
} from "@/components/dashboard/CollapsibleSidebar";
import { signOutEverywhere } from "@/lib/auth/sign-out";

const sidebarItems: CollapsibleSidebarItem[] = [
  { name: "Home", icon: Home, path: "home" },
  { name: "Announcements", icon: Megaphone, path: "announcements" },
  { name: "Support Tickets", icon: Ticket, path: "tickets" },
  { name: "User Feedback", icon: Star, path: "feedback" },
  { name: "Users", icon: Users, path: "users" },
  { name: "Content Moderation", icon: Shield, path: "moderation" },
  { name: "Appointments", icon: Calendar, path: "appointments" },
  { name: "Waitlists", icon: Clock, path: "waitlists" },
  { name: "Payments", icon: CreditCard, path: "payments" },
  { name: "Payouts", icon: Wallet, path: "payouts" },
  { name: "Invoices", icon: Receipt, path: "invoices" },
  { name: "Refunds", icon: RotateCcw, path: "refunds" },
  { name: "Disputes", icon: AlertTriangle, path: "disputes" },
  { name: "Subscriptions", icon: RefreshCw, path: "subscriptions" },
  { name: "Metrics", icon: BarChart3, path: "metrics" },
  { name: "Settings", icon: Settings, path: "settings" },
];

export function StaffShell({
  staffId,
  userName,
  userEmail,
  userImage,
  children,
}: {
  staffId: string;
  userName: string | null;
  userEmail: string | null;
  userImage: string | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  // Sync user as Novu subscriber (once per session)
  useNovuSubscriberSync();

  return (
    <NovuProvider>
      <div className="flex h-screen-maintenance bg-zinc-50 dark:bg-zinc-950">
        <CollapsibleSidebar
          items={sidebarItems}
          basePath={`/dashboard/staff/${staffId}`}
          title="Staff Portal"
          footerLabel="Familiarise Staff v1.0"
          avatarFallback="S"
          userName={userName || "Staff Member"}
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
