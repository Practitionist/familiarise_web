"use client";

/**
 * Staff dashboard chrome: the staff-specific nav config, delegating all
 * layout/chrome to the shared OperatorDashboardShell. Sits inside the
 * server `layout.tsx`, which enforces the staff-access rule and resolves the
 * identity props on the server.
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

import {
  OperatorDashboardShell,
  type OperatorDashboardShellProps,
} from "@/components/dashboard/OperatorDashboardShell";
import { type CollapsibleSidebarItem } from "@/components/dashboard/CollapsibleSidebar";

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
}: { staffId: string } & Pick<
  OperatorDashboardShellProps,
  "userName" | "userEmail" | "userImage" | "children"
>) {
  return (
    <OperatorDashboardShell
      sidebarItems={sidebarItems}
      basePath={`/dashboard/staff/${staffId}`}
      title="Staff Portal"
      breadcrumbRoot="Staff"
      footerLabel="Familiarise Staff v1.0"
      avatarFallback="S"
      userName={userName}
      userEmail={userEmail}
      userImage={userImage}
    >
      {children}
    </OperatorDashboardShell>
  );
}
