"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type LucideIcon } from "lucide-react";
import {
  CollapsibleSidebar,
  CollapsibleSidebarSkeleton,
  type CollapsibleSidebarGroup,
  type CollapsibleSidebarProps,
} from "@/components/dashboard/CollapsibleSidebar";
import {
  DashboardContextBar,
  type DashboardContextBarProps,
} from "@/components/dashboard/DashboardContextBar";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { isActiveRoute } from "@/components/dashboard/route-active";
import { LinkPendingIcon } from "@/components/ui/NavLink";

export interface PersonalDashboardMobileTab {
  label: string;
  path: string;
  Icon: LucideIcon;
}

export interface PersonalDashboardShellProps {
  /** Grouped sidebar nav (see CollapsibleSidebarGroup). */
  groups: CollapsibleSidebarGroup[];
  /** Prefix prepended to every nav path, e.g. `/dashboard/consultant/<id>`. */
  basePath: string;
  /** Primary line of the sidebar header (e.g. "Consultant Dashboard"). */
  title: string;
  /** Secondary line under the title (e.g. the user's display name). */
  subtitle?: string | null;
  /** Avatar shown in the sidebar header. */
  headerImage?: string | null;
  /** Personal chip at the sidebar bottom — "who am I". */
  bottomUserChip?: CollapsibleSidebarProps["bottomUserChip"];
  /** Dropdown actions on the chip (Settings / Help / org switching). */
  bottomUserChipActions?: CollapsibleSidebarProps["bottomUserChipActions"];
  /** Sticky top strip config (identity, status badges, breadcrumbs). */
  contextBar: DashboardContextBarProps;
  /** Bottom tab bar below md — pick the 5 most-accessed routes. */
  mobileTabs: PersonalDashboardMobileTab[];
  /**
   * Full-width banner slot between the context bar and the page content.
   * The consultant layout mounts its verification banner here.
   */
  banner?: React.ReactNode;
  /** Current pathname from usePathname() — drives active states. */
  pathname: string;
  onSignOut: () => void;
  children: React.ReactNode;
}

/**
 * Shared chrome for the personal (consultant / consultee) dashboards —
 * the same shell contract as the organization dashboard layout, extracted
 * so all three role surfaces render one design language:
 *
 *   ┌ sidebar (md+) ┬ context bar (sticky h-14) ┐
 *   │ grouped nav   ├ banner slot               │
 *   │ …             ├ main p-6 (error boundary) │
 *   │ user chip     │                           │
 *   └───────────────┴ mobile bottom tabs (<md) ─┘
 *
 * The layouts stay thin: they resolve session/role data and hand this
 * component pure props. Anything visual added here lands on every role's
 * dashboard at once.
 */
export function PersonalDashboardShell({
  groups,
  basePath,
  title,
  subtitle,
  headerImage,
  bottomUserChip,
  bottomUserChipActions,
  contextBar,
  mobileTabs,
  banner,
  pathname,
  onSignOut,
  children,
}: PersonalDashboardShellProps) {
  const router = useRouter();

  const goToNavPath = (path: string) => {
    const href = path ? `${basePath}/${path}` : basePath;
    if (pathname === href) return;
    router.push(href);
  };

  return (
    <div className="flex h-screen-maintenance bg-zinc-50 dark:bg-zinc-950">
      {/* Collapsible sidebar — hidden on mobile, visible on md+ */}
      <div className="hidden md:block shrink-0">
        <CollapsibleSidebar
          groups={groups}
          basePath={basePath}
          title={title}
          avatarFallback={title.charAt(0).toUpperCase()}
          userName={title}
          userImage={headerImage}
          userSubtitle={subtitle}
          bottomUserChip={bottomUserChip}
          bottomUserChipActions={bottomUserChipActions}
          pathname={pathname}
          onSignOut={onSignOut}
        />
      </div>

      {/* Right panel: context bar + banner + page content */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <DashboardContextBar {...contextBar} />

        {banner}

        <main className="flex-1 overflow-y-auto pb-16 md:pb-0">
          <div className="p-4 sm:p-6 lg:p-8">
            <DashboardErrorBoundary>{children}</DashboardErrorBoundary>
          </div>
        </main>

        {/* Mobile bottom tab bar — only visible below md breakpoint */}
        <nav className="md:hidden fixed bottom-0 left-0 right-0 z-20 bg-white dark:bg-zinc-900 border-t border-zinc-200 dark:border-zinc-800 flex">
          {mobileTabs.map(({ label, path, Icon }) => {
            const isActive = isActiveRoute(pathname, basePath, path);
            return (
              <Link
                key={path}
                href={`${basePath}/${path}`}
                onClick={(e) => {
                  e.preventDefault();
                  goToNavPath(path);
                }}
                className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 text-[10px] font-medium transition-colors ${
                  isActive
                    ? "text-zinc-900 dark:text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                }`}
              >
                <LinkPendingIcon
                  Icon={Icon}
                  className={`h-5 w-5 ${isActive ? "text-zinc-900 dark:text-zinc-100" : "text-zinc-400 dark:text-zinc-500"}`}
                />
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}

/**
 * Loading skeleton matching the shell's visual footprint. Delegates to the
 * sidebar skeleton (which already mirrors the w-64 aside + content column)
 * so the layout doesn't flash between loading and mounted states.
 */
export function PersonalDashboardShellSkeleton() {
  return <CollapsibleSidebarSkeleton />;
}
