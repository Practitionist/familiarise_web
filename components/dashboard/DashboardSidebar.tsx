"use client";

import { cn } from "@/utils/tailwind";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { NavLink } from "@/components/ui/NavLink";
import { usePathname, useRouter } from "next/navigation";
import {
  Home,
  MessageSquare,
  Calendar,
  ClipboardList,
  FileText,
  HelpCircle,
  Settings,
  ChevronRight,
  LayoutDashboard,
  CreditCard,
  Clock,
  RefreshCw,
  AlertTriangle,
  BarChart3,
  Users,
  Briefcase,
  History,
  Ticket,
  Shield,
  Wallet,
  CheckCircle,
  Loader,
  ClipboardCheck,
  RotateCcw,
  Video,
  Megaphone,
  LifeBuoy,
  Timer,
  Server,
  Gift,
  Wrench,
} from "lucide-react";

// Icon mapping for dynamic icon rendering
const iconMap: Record<string, typeof Home> = {
  home: Home,
  chats: MessageSquare,
  appointments: Calendar,
  planner: ClipboardList,
  requests: FileText,
  documents: FileText,
  help: HelpCircle,
  settings: Settings,
  overview: LayoutDashboard,
  payments: CreditCard,
  "approval-payments": Clock,
  refunds: RotateCcw,
  disputes: AlertTriangle,
  analytics: BarChart3,
  users: Users,
  history: History,
  messages: MessageSquare,
  feedback: Ticket,
  policy: Shield,
  recordings: Video,
  // Payout related icons
  wallet: Wallet,
  "payouts/pending": ClipboardCheck,
  "payouts/processing": Loader,
  "payouts/completed": CheckCircle,
  "payouts/earnings": Wallet,
  subscriptions: RefreshCw,
  invoices: FileText,
  announcements: Megaphone,
  tickets: LifeBuoy,
  waitlists: Timer,
  "system-jobs": Server,
  maintenance: Wrench,
  trials: Gift,
  gift: Gift,
};

interface NavItem {
  name: string;
  path: string;
  icon?: string;
  badge?: number | string;
}

export interface NavSection {
  title: string | null;
  items: NavItem[];
}

export interface OrgMembershipEntry {
  organizationId: string;
  organizationName: string;
  organizationLogo: string | null;
  role: string;
}

interface DashboardSidebarProps {
  userImage?: string | null;
  userName?: string | null;
  userRole: "CONSULTANT" | "CONSULTEE" | "ADMIN" | "STAFF";
  basePath: string;
  navItems?: NavItem[];
  navSections?: NavSection[];
  isLoading?: boolean;
  bottomNavItems?: NavItem[];
  hideBottomActions?: boolean;
  /** Org memberships for the "Teams & Orgs" section at the bottom of the sidebar. */
  orgMemberships?: OrgMembershipEntry[];
}

export function DashboardSidebar({
  userImage,
  userName,
  userRole,
  basePath,
  navItems = [],
  navSections = [],
  isLoading = false,
  bottomNavItems: _bottomNavItems = [],
  hideBottomActions: _hideBottomActions = false,
}: DashboardSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();

  // Get current path relative to basePath for matching
  const relativePath = pathname.replace(basePath + "/", "");

  const getRoleColor = () => {
    switch (userRole) {
      case "ADMIN":
        return "bg-red-500/10 text-red-400 border-red-500/20";
      case "CONSULTANT":
        return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
      case "CONSULTEE":
        return "bg-blue-500/10 text-blue-400 border-blue-500/20";
      case "STAFF":
        return "bg-amber-500/10 text-amber-400 border-amber-500/20";
      default:
        return "bg-zinc-500/10 text-zinc-400 border-zinc-500/20";
    }
  };

  const handleNavHover = (path: string) => {
    router.prefetch(`${basePath}/${path}`);
  };

  const renderIcon = (iconName?: string) => {
    if (!iconName) return null;
    const IconComponent = iconMap[iconName.toLowerCase()];
    if (!IconComponent) return null;
    return <IconComponent className="w-5 h-5" />;
  };

  return (
    <div className="flex h-full flex-col bg-zinc-950 text-white">
      {/* Logo/Brand */}
      <div className="flex h-16 items-center gap-3 border-b border-zinc-800/50 px-6">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-zinc-700 to-zinc-800 shadow-lg">
          <Briefcase className="h-5 w-5 text-zinc-100" />
        </div>
        <div>
          <span className="text-lg font-semibold tracking-tight">
            Familiarise
          </span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto scrollbar-hide p-3">
        {/* Render sectioned navigation if navSections is provided */}
        {navSections.length > 0 ? (
          <div className="space-y-4">
            {navSections.map((section, sectionIndex) => (
              <div key={sectionIndex}>
                {section.title && (
                  <h3 className="px-3 py-2 text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                    {section.title}
                  </h3>
                )}
                <ul className="space-y-1">
                  {section.items.map((item) => {
                    const isActive =
                      relativePath === item.path ||
                      relativePath.startsWith(item.path + "/");

                    return (
                      <li key={item.path}>
                        <NavLink
                          href={`${basePath}/${item.path}`}
                          className={cn(
                            "group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-150",
                            isActive
                              ? "bg-zinc-800 text-white shadow-sm"
                              : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-100",
                          )}
                          prefetch={true}
                          onMouseEnter={() => handleNavHover(item.path)}
                        >
                          <span
                            className={cn(
                              "flex h-8 w-8 items-center justify-center rounded-md transition-colors",
                              isActive
                                ? "bg-zinc-700 text-white"
                                : "bg-zinc-800/50 text-zinc-500 group-hover:bg-zinc-700 group-hover:text-zinc-300",
                            )}
                          >
                            {renderIcon(item.icon || item.path)}
                          </span>
                          <span className="flex-1">{item.name}</span>
                          {item.badge && (
                            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-zinc-700 px-1.5 text-xs font-semibold text-zinc-200">
                              {item.badge}
                            </span>
                          )}
                          <ChevronRight
                            className={cn(
                              "w-4 h-4 transition-opacity",
                              isActive
                                ? "opacity-100 text-zinc-500"
                                : "opacity-0 group-hover:opacity-50",
                            )}
                          />
                        </NavLink>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          /* Render flat navigation for backward compatibility */
          <ul className="space-y-1">
            {navItems.map((item) => {
              const isActive =
                relativePath === item.path ||
                relativePath.startsWith(item.path + "/");

              return (
                <li key={item.path}>
                  <NavLink
                    href={`${basePath}/${item.path}`}
                    className={cn(
                      "group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-150",
                      isActive
                        ? "bg-zinc-800 text-white shadow-sm"
                        : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-100",
                    )}
                    prefetch={true}
                    onMouseEnter={() => handleNavHover(item.path)}
                  >
                    <span
                      className={cn(
                        "flex h-8 w-8 items-center justify-center rounded-md transition-colors",
                        isActive
                          ? "bg-zinc-700 text-white"
                          : "bg-zinc-800/50 text-zinc-500 group-hover:bg-zinc-700 group-hover:text-zinc-300",
                      )}
                    >
                      {renderIcon(item.icon || item.path)}
                    </span>
                    <span className="flex-1">{item.name}</span>
                    {item.badge && (
                      <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-zinc-700 px-1.5 text-xs font-semibold text-zinc-200">
                        {item.badge}
                      </span>
                    )}
                    <ChevronRight
                      className={cn(
                        "w-4 h-4 transition-opacity",
                        isActive
                          ? "opacity-100 text-zinc-500"
                          : "opacity-0 group-hover:opacity-50",
                      )}
                    />
                  </NavLink>
                </li>
              );
            })}
          </ul>
        )}
      </nav>

      {/* User identity — boxed, at the bottom-left (mirrors the org sidebar).
          Org switching/creation lives in the org context switcher, not here. */}
      <div className="border-t border-zinc-800/50 p-3">
        {isLoading ? (
          <div className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
            <Skeleton className="h-10 w-10 rounded-full bg-zinc-800" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-28 bg-zinc-800" />
              <Skeleton className="h-3 w-20 bg-zinc-800" />
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
            <Avatar className="h-10 w-10 ring-2 ring-zinc-800 ring-offset-1 ring-offset-zinc-950">
              <AvatarImage
                src={userImage || "/placeholder-user.jpg"}
                alt={userName || ""}
              />
              <AvatarFallback className="bg-zinc-800 text-zinc-300">
                {userName?.charAt(0) || "?"}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-zinc-100">
                {userName || "User"}
              </p>
              <span
                className={cn(
                  "mt-0.5 inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium",
                  getRoleColor(),
                )}
              >
                {userRole}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
