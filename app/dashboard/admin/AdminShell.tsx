"use client";

/**
 * Admin dashboard chrome: the admin-specific nav config, delegating all
 * layout/chrome to the shared OperatorDashboardShell. Sits inside the
 * server `layout.tsx`, which runs the requireUserRole("ADMIN") guard and
 * resolves the identity props on the server.
 */

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

import {
  OperatorDashboardShell,
  type OperatorDashboardShellProps,
} from "@/components/dashboard/OperatorDashboardShell";
import { type CollapsibleSidebarItem } from "@/components/dashboard/CollapsibleSidebar";

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
}: Pick<
  OperatorDashboardShellProps,
  "userName" | "userEmail" | "userImage" | "children"
>) {
  return (
    <OperatorDashboardShell
      sidebarItems={sidebarItems}
      basePath="/dashboard/admin"
      title="Admin Portal"
      breadcrumbRoot="Admin"
      footerLabel="Familiarise Admin v1.0"
      avatarFallback="A"
      userName={userName}
      userEmail={userEmail}
      userImage={userImage}
      prefetchPaths={["/dashboard/admin/home", "/dashboard/admin/payments"]}
    >
      {children}
    </OperatorDashboardShell>
  );
}
