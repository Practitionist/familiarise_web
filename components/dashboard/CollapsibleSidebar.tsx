"use client";

import Link from "next/link";
import {
  createContext,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/utils/tailwind";
import { Button } from "@/components/ui/button";
import { LinkPendingIcon } from "@/components/ui/NavLink";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { isActiveRoute } from "@/components/dashboard/route-active";
import type { NavItem } from "@/lib/dashboard/nav/types";

export interface CollapsibleSidebarItem extends NavItem {
  /** Resolved count (from the shell's badge map); hidden when 0/undefined. */
  badge?: number;
}

/**
 * A labelled cluster of nav items. Omitting `label` renders a headerless top
 * cluster; `defaultCollapsed` starts a group closed (the org Resources group
 * for OWNER/MAINTAINER).
 */
export interface CollapsibleSidebarGroup {
  label?: string;
  items: CollapsibleSidebarItem[];
  defaultCollapsed?: boolean;
}

/** "99+" cap; null hides the pill. */
export function formatNavBadge(count: number | undefined): string | null {
  if (!count || count <= 0) return null;
  return count > 99 ? "99+" : String(count);
}

const SidebarCollapsedContext = createContext(false);

/** Lets header/footer slot content render its icon-only form. */
export function useSidebarCollapsed(): boolean {
  return useContext(SidebarCollapsedContext);
}

// ── Persisted collapse (#1527: it never survived a reload) ────────────────
const COLLAPSE_EVENT = "fw:sidebar-collapse";
// In-memory mirror so the toggle still works where localStorage throws.
const collapseMemory = new Map<string, boolean>();

function subscribeCollapse(notify: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key) collapseMemory.delete(event.key);
    notify();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(COLLAPSE_EVENT, notify);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(COLLAPSE_EVENT, notify);
  };
}

function readCollapsed(key: string): boolean {
  const remembered = collapseMemory.get(key);
  if (remembered !== undefined) return remembered;
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function usePersistedCollapse(key: string): [boolean, (next: boolean) => void] {
  const collapsed = useSyncExternalStore(
    subscribeCollapse,
    () => readCollapsed(key),
    () => false,
  );
  const setCollapsed = useCallback(
    (next: boolean) => {
      collapseMemory.set(key, next);
      try {
        window.localStorage.setItem(key, next ? "1" : "0");
      } catch {
        // Private mode / quota: the in-memory mirror still applies.
      }
      window.dispatchEvent(new Event(COLLAPSE_EVENT));
    },
    [key],
  );
  return [collapsed, setCollapsed];
}

// ── Nav rows (shared by the sidebar and the mobile Menu sheet) ────────────

interface SidebarNavLinkProps {
  item: CollapsibleSidebarItem;
  basePath: string;
  pathname: string;
  collapsed?: boolean;
  onNavigate?: () => void;
}

export function SidebarNavLink({
  item,
  basePath,
  pathname,
  collapsed = false,
  onNavigate,
}: Readonly<SidebarNavLinkProps>) {
  const active = isActiveRoute(pathname, basePath, item.path);
  const badge = formatNavBadge(item.badge);
  const link = (
    <Link
      href={`${basePath}/${item.path}`}
      onClick={onNavigate}
      aria-label={collapsed ? item.name : undefined}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
        active
          ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
          : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100",
      )}
    >
      <LinkPendingIcon Icon={item.icon} />
      {collapsed ? (
        <span className="sr-only">{item.name}</span>
      ) : (
        <span className="min-w-0 flex-1 truncate">{item.name}</span>
      )}
      {badge &&
        (collapsed ? (
          <span
            className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-red-500"
            aria-hidden
          />
        ) : (
          <span className="ml-auto min-w-[18px] shrink-0 rounded-full bg-red-500 px-1.5 py-0.5 text-center text-[10px] font-semibold leading-none text-white">
            {badge}
            <span className="sr-only"> new</span>
          </span>
        ))}
    </Link>
  );
  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">
        {item.name}
        {badge ? ` (${badge})` : ""}
      </TooltipContent>
    </Tooltip>
  );
}

interface SidebarNavGroupsProps {
  groups: CollapsibleSidebarGroup[];
  basePath: string;
  pathname: string;
  collapsed?: boolean;
  onNavigate?: () => void;
}

/** Grouped nav with toggleable group headers (hidden in icon-only mode). */
export function SidebarNavGroups({
  groups,
  basePath,
  pathname,
  collapsed = false,
  onNavigate,
}: Readonly<SidebarNavGroupsProps>) {
  // Only explicit toggles are stored; untouched groups follow their default.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  return (
    <TooltipProvider delayDuration={0}>
      <div className="space-y-3">
        {groups.map((group, gi) => {
          const label = group.label;
          const closed =
            !collapsed &&
            !!label &&
            (toggled[label] ?? !!group.defaultCollapsed);
          return (
            <div key={label ?? `__group_${gi}`}>
              {!collapsed && label && (
                <button
                  type="button"
                  onClick={() =>
                    setToggled((prev) => ({ ...prev, [label]: !closed }))
                  }
                  className="flex w-full items-center gap-1 px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 transition-colors hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
                  aria-expanded={!closed}
                >
                  <ChevronDown
                    className={cn(
                      "h-3 w-3 transition-transform",
                      closed && "-rotate-90",
                    )}
                  />
                  {label}
                </button>
              )}
              {!closed && (
                <ul className="space-y-1">
                  {group.items.map((item) => (
                    <li key={item.path}>
                      <SidebarNavLink
                        item={item}
                        basePath={basePath}
                        pathname={pathname}
                        collapsed={collapsed}
                        onNavigate={onNavigate}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

export interface CollapsibleSidebarProps {
  groups: CollapsibleSidebarGroup[];
  /** Prepended to every item path. */
  basePath: string;
  pathname: string;
  /** Top slot — the ContextSwitcher (#1527 Q1). */
  header?: ReactNode;
  /** Bottom slot — utility links, pinned CTA, account chip. */
  footer?: ReactNode;
  /** localStorage key for the collapsed state, one per shell kind. */
  storageKey: string;
  className?: string;
}

/**
 * Desktop sidebar for every dashboard shell. Width animates between `w-64`
 * and `w-16`; slot content reads `useSidebarCollapsed()` to go icon-only.
 */
export function CollapsibleSidebar({
  groups,
  basePath,
  pathname,
  header,
  footer,
  storageKey,
  className,
}: Readonly<CollapsibleSidebarProps>) {
  const [collapsed, setCollapsed] = usePersistedCollapse(storageKey);

  return (
    <SidebarCollapsedContext.Provider value={collapsed}>
      <aside
        className={cn(
          "flex h-full flex-col border-r border-border bg-card transition-all duration-300",
          collapsed ? "w-16" : "w-64",
          className,
        )}
      >
        {/* h-14 pixel-matches the DashboardContextBar so the borders meet. */}
        <div className="border-b border-border">
          <div
            className={cn(
              "flex h-14 items-center gap-1 px-2",
              collapsed && "h-auto flex-col gap-2 py-2",
            )}
          >
            <div className={cn("min-w-0 flex-1", collapsed && "w-full")}>
              {header}
            </div>
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

        <nav
          aria-label="Dashboard"
          className="flex-1 overflow-y-auto px-3 py-4"
        >
          <SidebarNavGroups
            groups={groups}
            basePath={basePath}
            pathname={pathname}
            collapsed={collapsed}
          />
        </nav>

        {footer && (
          <div className="space-y-1 border-t border-zinc-200 p-2 dark:border-zinc-800">
            {footer}
          </div>
        )}
      </aside>
    </SidebarCollapsedContext.Provider>
  );
}

/**
 * Loading skeleton matching the shell's footprint. Layout fallback only —
 * never inside a segment `loading.tsx` whose parent already renders a shell
 * (that nests a second `h-screen-maintenance` viewport).
 */
export function CollapsibleSidebarSkeleton() {
  return (
    <div className="flex h-screen-maintenance overflow-hidden bg-zinc-50 dark:bg-zinc-950">
      {/* Hidden below md, like the real sidebar (#1527). */}
      <aside className="hidden h-full w-64 border-r border-border bg-card p-4 md:block">
        <Skeleton className="mb-6 h-8 w-32" />
        <div className="space-y-2">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Skeleton key={i} className="h-10 w-full rounded-lg" />
          ))}
        </div>
      </aside>
      <main className="relative min-h-0 flex-1 p-4 sm:p-6 lg:p-8">
        <Skeleton className="mb-4 h-8 w-64" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </main>
    </div>
  );
}
