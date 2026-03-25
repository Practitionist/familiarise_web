"use client";

import { cn } from "@/utils/tailwind";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { signOut } from "@/lib/auth-client";
import { disconnectStreamClients } from "@/providers/StreamProvider";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  Home,
  MessageSquare,
  Calendar,
  ClipboardList,
  FileText,
  HelpCircle,
  Settings,
  LogOut,
  ArrowLeft,
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
import { ReactNode } from "react";

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

export interface NavItem {
  name: string;
  path: string;
  icon?: string;
  badge?: number | string;
}

export interface NavSection {
  title: string | null;
  items: NavItem[];
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
}

export function DashboardSidebar({
  userImage,
  userName,
  userRole,
  basePath,
  navItems = [],
  navSections = [],
  isLoading = false,
  bottomNavItems = [],
  hideBottomActions = false,
}: DashboardSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();

  // Get current path relative to basePath for matching
  const relativePath = pathname.replace(basePath + "/", "");

  const handleSignOut = async () => {
    try {
      await disconnectStreamClients();
    } catch {
      // Don't block sign-out if disconnect fails
    }
    signOut();
  };

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

      {/* User Profile */}
      <div className="border-b border-zinc-800/50 p-4">
        {isLoading ? (
          <div className="flex items-center gap-3">
            <Skeleton className="h-12 w-12 rounded-full bg-zinc-800" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-28 bg-zinc-800" />
              <Skeleton className="h-3 w-20 bg-zinc-800" />
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <Avatar className="h-12 w-12 ring-2 ring-zinc-700 ring-offset-2 ring-offset-zinc-950">
              <AvatarImage
                src={userImage || "/placeholder-user.jpg"}
                alt={userName || ""}
              />
              <AvatarFallback className="bg-zinc-800 text-zinc-300">
                {userName?.charAt(0) || "?"}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <p className="font-medium truncate text-zinc-100">
                {userName || "User"}
              </p>
              <span
                className={cn(
                  "inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border",
                  getRoleColor(),
                )}
              >
                {userRole}
              </span>
            </div>
          </div>
        )}
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
                        <Link
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
                        </Link>
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
                  <Link
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
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </nav>

      {/* Bottom Section */}
      {!hideBottomActions && (
        <div className="border-t border-zinc-800/50 p-3 space-y-1">
          <Link
            href="/"
            className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-100 transition-all"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-zinc-800/50 text-zinc-500">
              <ArrowLeft className="w-5 h-5" />
            </span>
            <span>Back to Home</span>
          </Link>

          {bottomNavItems.map((item) => {
            const isActive =
              relativePath === item.path ||
              relativePath.startsWith(item.path + "/");

            return (
              <Link
                key={item.path}
                href={`${basePath}/${item.path}`}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all",
                  isActive
                    ? "bg-zinc-800 text-white"
                    : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-100",
                )}
                prefetch={true}
                onMouseEnter={() => handleNavHover(item.path)}
              >
                <span
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-md",
                    isActive
                      ? "bg-zinc-700 text-white"
                      : "bg-zinc-800/50 text-zinc-500",
                  )}
                >
                  {renderIcon(item.path)}
                </span>
                <span>{item.name}</span>
              </Link>
            );
          })}

          <button
            onClick={handleSignOut}
            className="w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-red-400 hover:bg-red-500/10 hover:text-red-300 transition-all"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-red-500/10 text-red-500">
              <LogOut className="w-5 h-5" />
            </span>
            <span>Sign Out</span>
          </button>
        </div>
      )}
    </div>
  );
}
