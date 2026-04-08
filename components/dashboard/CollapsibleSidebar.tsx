"use client";

import { cn } from "@/utils/tailwind";
import { ChevronLeft, ChevronRight, LogOut, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";

export interface CollapsibleSidebarItem {
  name: string;
  icon: LucideIcon;
  path: string;
}

export interface CollapsibleSidebarProps {
  /** Items to render in the nav list (flat list, in order). */
  items: CollapsibleSidebarItem[];
  /** Base path that gets prepended to each `item.path` to build the link href. */
  basePath: string;
  /** Title shown in the sidebar header (e.g. "Staff Portal", "Admin Portal"). */
  title: string;
  /** Footer label shown when expanded (e.g. "Familiarise Staff v1.0"). */
  footerLabel?: string;
  /** Avatar fallback letter if user has no image / name. */
  avatarFallback?: string;
  userName?: string | null;
  userEmail?: string | null;
  userImage?: string | null;
  /** Current pathname (from `usePathname()`). Used to compute active state. */
  pathname: string;
  /** Sign-out handler invoked when the footer button is clicked. */
  onSignOut: () => void;
}

/**
 * Shared collapsible flat sidebar used by both the Staff and Admin dashboards.
 *
 * Visual contract: a vertical white/zinc panel with a profile header, an icon-only
 * collapse toggle, a flat list of nav links with icons (tooltips when collapsed),
 * and a footer Sign Out button. Width animates between `w-64` (expanded) and
 * `w-16` (collapsed).
 */
export function CollapsibleSidebar({
  items,
  basePath,
  title,
  footerLabel,
  avatarFallback,
  userName,
  userEmail,
  userImage,
  pathname,
  onSignOut,
}: CollapsibleSidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

  const isActive = (path: string) => pathname.includes(`${basePath}/${path}`);

  const fallbackChar =
    avatarFallback ??
    userName?.charAt(0)?.toUpperCase() ??
    title.charAt(0).toUpperCase();

  return (
    <aside
      className={cn(
        "flex h-full flex-col border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 transition-all duration-300",
        collapsed ? "w-16" : "w-64",
      )}
    >
      {/* Header with User Profile */}
      <div className="border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center justify-between h-16 px-4">
          {!collapsed && (
            <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              {title}
            </h1>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCollapsed(!collapsed)}
            className="h-8 w-8"
          >
            {collapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-4 w-4" />
            )}
          </Button>
        </div>

        {/* User Profile */}
        <div className={cn("px-4 pb-4", collapsed && "px-2")}>
          <div
            className={cn(
              "flex items-center gap-3",
              collapsed && "justify-center",
            )}
          >
            <Avatar className="h-10 w-10 flex-shrink-0">
              <AvatarImage src={userImage || ""} alt={userName || ""} />
              <AvatarFallback className="bg-blue-600 text-white font-semibold">
                {fallbackChar}
              </AvatarFallback>
            </Avatar>
            {!collapsed && (
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                  {userName || title}
                </p>
                {userEmail && (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                    {userEmail}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-4">
        <TooltipProvider delayDuration={0}>
          <ul className="space-y-1 px-2">
            {items.map((item) => (
              <li key={item.path}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Link
                      href={`${basePath}/${item.path}`}
                      className={cn(
                        "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                        isActive(item.path)
                          ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                          : "text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-zinc-800",
                      )}
                    >
                      <item.icon className="h-5 w-5 flex-shrink-0" />
                      {!collapsed && <span>{item.name}</span>}
                    </Link>
                  </TooltipTrigger>
                  {collapsed && (
                    <TooltipContent side="right">{item.name}</TooltipContent>
                  )}
                </Tooltip>
              </li>
            ))}
          </ul>
        </TooltipProvider>
      </nav>

      {/* Footer */}
      <div className="border-t border-zinc-200 dark:border-zinc-800 p-2">
        <TooltipProvider delayDuration={0}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onSignOut}
                className={cn(
                  "flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950",
                  collapsed && "justify-center",
                )}
              >
                <LogOut className="h-5 w-5 flex-shrink-0" />
                {!collapsed && <span>Sign Out</span>}
              </button>
            </TooltipTrigger>
            {collapsed && (
              <TooltipContent side="right">Sign Out</TooltipContent>
            )}
          </Tooltip>
        </TooltipProvider>
        {!collapsed && footerLabel && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-3 px-3">
            {footerLabel}
          </p>
        )}
      </div>
    </aside>
  );
}

/**
 * Loading skeleton that matches {@link CollapsibleSidebar}'s visual footprint.
 *
 * Render this while user/session data is still loading so the layout doesn't
 * flash between states. Used by both the admin and staff dashboard layouts —
 * keep it DRY with the real sidebar's classes so the width and background
 * stay aligned when the real component mounts.
 */
export function CollapsibleSidebarSkeleton() {
  return (
    <div className="flex h-screen-maintenance bg-zinc-50 dark:bg-zinc-950">
      {/* Sidebar skeleton — mirrors the expanded w-64 layout */}
      <aside className="w-64 border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
        <Skeleton className="h-8 w-32 mb-6" />
        <div className="space-y-2">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Skeleton key={i} className="h-10 w-full rounded-lg" />
          ))}
        </div>
      </aside>
      {/* Main content skeleton */}
      <main className="flex-1 p-6">
        <Skeleton className="h-8 w-64 mb-4" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </main>
    </div>
  );
}
