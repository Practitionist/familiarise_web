"use client";

import { cn } from "@/utils/tailwind";
import { ChevronLeft, ChevronRight, ChevronDown, LogOut, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  /**
   * When provided, a personal user chip is rendered at the bottom of the
   * sidebar (VS Code / Linear style). The header avatar then represents the
   * entity (org, portal) rather than the person. `role` is shown as a small
   * muted badge below the user's name.
   */
  bottomUserChip?: {
    name: string | null;
    image: string | null;
    role: string;
  };
  /**
   * When provided alongside `bottomUserChip`, the chip becomes a dropdown
   * trigger. Each entry is either a labelled action or a visual separator.
   * Use this to wire up "Personal Dashboard", org-switch links, and Sign Out
   * so all context-switching lives in one discoverable place.
   */
  bottomUserChipActions?: Array<
    | { type: "item"; label: string; href?: string; onClick?: () => void; icon?: LucideIcon }
    | { type: "separator" }
    | { type: "label"; label: string }
  >;
  /**
   * When provided, the top header (avatar + title + subtitle) becomes a
   * dropdown trigger. Used by the org dashboard to expose the org switcher
   * at the top of the sidebar (the Linear / Agentstack pattern): the top
   * answers "which context am I in?" while the bottom chip answers
   * "who am I?".
   */
  topDropdownActions?: Array<
    | { type: "item"; label: string; href?: string; onClick?: () => void; icon?: LucideIcon }
    | { type: "separator" }
    | { type: "label"; label: string }
  >;
  /** Optional subtitle shown under `userName` in the top header (e.g. "Buyer · SEAT_PACK"). */
  userSubtitle?: string | null;
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
  userSubtitle,
  bottomUserChip,
  bottomUserChipActions,
  topDropdownActions,
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
      {/* Header: single-row layout, fixed h-14 to pixel-match the
          OrgContextBar's h-14 so the sidebar / top-bar border intersection
          lines up cleanly at the crossroad. */}
      <div className="border-b border-zinc-200 dark:border-zinc-800">
        <div
          className={cn(
            "flex items-center gap-1 h-14 px-2",
            collapsed && "h-auto flex-col gap-2 py-2",
          )}
        >
          {/* Identity block (dropdown or static) — takes all remaining space */}
          {topDropdownActions ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className={cn(
                    "flex items-center gap-3 flex-1 min-w-0 px-2 py-1.5 rounded-md text-left hover:bg-zinc-100 dark:hover:bg-zinc-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300 transition-colors",
                    collapsed && "w-full justify-center px-0",
                  )}
                  aria-label="Switch context"
                >
                  <Avatar className="h-9 w-9 flex-shrink-0">
                    <AvatarImage src={userImage || ""} alt={userName || ""} />
                    <AvatarFallback className="bg-blue-600 text-white font-semibold text-xs">
                      {fallbackChar}
                    </AvatarFallback>
                  </Avatar>
                  {!collapsed && (
                    <>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate leading-tight">
                          {userName || title}
                        </p>
                        {(userSubtitle ?? userEmail) && (
                          <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate leading-tight mt-0.5">
                            {userSubtitle ?? userEmail}
                          </p>
                        )}
                      </div>
                      <ChevronDown className="h-4 w-4 text-zinc-400 shrink-0" />
                    </>
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="bottom" align="start" className="w-60">
                {topDropdownActions.map((action, i) => {
                  if (action.type === "separator") {
                    return <DropdownMenuSeparator key={i} />;
                  }
                  if (action.type === "label") {
                    return (
                      <DropdownMenuLabel
                        key={i}
                        className="text-xs text-zinc-400 font-normal py-1"
                      >
                        {action.label}
                      </DropdownMenuLabel>
                    );
                  }
                  const Icon = action.icon;
                  return (
                    <DropdownMenuItem
                      key={i}
                      asChild={!!action.href}
                      onClick={!action.href ? action.onClick : undefined}
                      className="cursor-pointer gap-2"
                    >
                      {action.href ? (
                        <Link href={action.href} className="flex items-center gap-2 w-full">
                          {Icon && <Icon className="h-4 w-4 text-zinc-500" />}
                          {action.label}
                        </Link>
                      ) : (
                        <>
                          {Icon && <Icon className="h-4 w-4 text-zinc-500" />}
                          {action.label}
                        </>
                      )}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <div
              className={cn(
                "flex items-center gap-3 flex-1 min-w-0 px-2 py-1.5",
                collapsed && "w-full justify-center px-0",
              )}
            >
              <Avatar className="h-9 w-9 flex-shrink-0">
                <AvatarImage src={userImage || ""} alt={userName || ""} />
                <AvatarFallback className="bg-blue-600 text-white font-semibold text-xs">
                  {fallbackChar}
                </AvatarFallback>
              </Avatar>
              {!collapsed && (
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate leading-tight">
                    {userName || title}
                  </p>
                  {(userSubtitle ?? userEmail) && (
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate leading-tight mt-0.5">
                      {userSubtitle ?? userEmail}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Collapse toggle — icon-only, sits next to the switcher */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCollapsed(!collapsed)}
            className="h-7 w-7 flex-shrink-0 text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
          >
            {collapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-4 w-4" />
            )}
          </Button>
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
                      aria-label={collapsed ? item.name : undefined}
                      aria-current={isActive(item.path) ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                        isActive(item.path)
                          ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                          : "text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-zinc-800",
                      )}
                    >
                      <item.icon className="h-5 w-5 flex-shrink-0" />
                      {collapsed ? (
                        <span className="sr-only">{item.name}</span>
                      ) : (
                        <span>{item.name}</span>
                      )}
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
      <div className="border-t border-zinc-200 dark:border-zinc-800 p-2 space-y-1">
        {/* Personal identity strip — always static, always non-clickable.
            All context-switching + sign-out lives in the top dropdown
            (single source of truth). This strip is pure visual reinforcement
            of "who am I right now". */}
        {bottomUserChip ? (
          <div
            className={cn(
              "flex items-center gap-2.5 px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/40",
              collapsed && "justify-center px-0 border-transparent bg-transparent",
            )}
          >
            <Avatar className="h-7 w-7 flex-shrink-0">
              <AvatarImage src={bottomUserChip.image || ""} alt={bottomUserChip.name || ""} />
              <AvatarFallback className="bg-zinc-700 text-white text-xs font-semibold">
                {(bottomUserChip.name ?? "U").charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            {!collapsed && (
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-zinc-900 dark:text-zinc-100 truncate leading-tight">
                  {bottomUserChip.name}
                </p>
                <p className="text-[10px] text-zinc-400 dark:text-zinc-500 truncate leading-tight mt-0.5">
                  {bottomUserChip.role}
                </p>
              </div>
            )}
          </div>
        ) : null}

        {/* Sign Out — always rendered below the chip/dropdown */}
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
