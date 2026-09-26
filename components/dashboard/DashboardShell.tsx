"use client";

import { useCallback, useMemo, type ReactNode } from "react";

import { useCssVarHeight } from "@/components/dashboard/useCssVarHeight";
import {
  CollapsibleSidebar,
  CollapsibleSidebarSkeleton,
  SidebarToggle,
  usePersistedCollapse,
  useSidebarShortcut,
  type CollapsibleSidebarGroup,
  type CollapsibleSidebarItem,
} from "@/components/dashboard/CollapsibleSidebar";
import {
  DashboardContextBar,
  type DashboardContextBarProps,
} from "@/components/dashboard/DashboardContextBar";
import {
  AccountMenu,
  HeaderCta,
  HelpMenu,
  type DashboardAccount,
} from "@/components/dashboard/DashboardShellParts";
import { MobileNav } from "@/components/dashboard/MobileNav";
import { NotificationInbox } from "@/components/notifications/NotificationInbox";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import NovuProvider from "@/providers/NovuProvider";
import { useNovuSubscriberSync } from "@/hooks/useNovuSubscriberSync";
import type { DashboardNav, NavItem } from "@/lib/dashboard/nav/types";

export type DashboardShellKind =
  | "personal"
  | "organization"
  | "workspace"
  | "backoffice";

export interface DashboardShellProps {
  /** Keys the persisted sidebar-collapse state. */
  kind: DashboardShellKind;
  nav: DashboardNav;
  /** Counts keyed by `NavItem.badgeKey`. */
  badges?: Record<string, number | undefined>;
  /** Rendered at the sidebar top and in the mobile Menu sheet. */
  switcher: ReactNode;
  /** The header avatar menu's person (#1527 — the rail has no account chip). */
  account: DashboardAccount;
  onSignOut: () => void;
  /** The shell owns both ends of the bar (sidebar toggle, right cluster). */
  contextBar: Omit<DashboardContextBarProps, "rightSlot" | "leadingSlot">;
  /** Full-width strip above <main> (verification / org status). */
  banner?: ReactNode;
  pathname: string;
  children: ReactNode;
}

function withBadge(
  item: NavItem,
  badges: Record<string, number | undefined> | undefined,
): CollapsibleSidebarItem {
  return item.badgeKey ? { ...item, badge: badges?.[item.badgeKey] } : item;
}

/**
 * The one dashboard chrome (#1527 §6), shared by the personal, organization,
 * workspace and back-office trees:
 *
 *   ┌ sidebar (md+) ─┬ bar: toggle · crumbs · CTA · Help · bell · avatar ┐
 *   │ switcher       ├ banner slot                                      │
 *   │ grouped nav    ├ main (error boundary)                            │
 *   │                ├ mobile tabs + Menu (<md)                         │
 *   └────────────────┴──────────────────────────────────────────────────┘
 *
 * #1527 (Cloudflare model): the person appears once, as the header avatar
 * menu, which also holds the personal / back-office Settings; Help once, in
 * the header; the collapse toggle leads the bar (Ctrl/⌘ \).
 *
 * It owns the Novu provider (the org tree mounted the inbox without one) and
 * the single error boundary. Layouts resolve data and pass pure props.
 */
export function DashboardShell({
  kind,
  nav,
  badges,
  switcher,
  account,
  onSignOut,
  contextBar,
  banner,
  pathname,
  children,
}: Readonly<DashboardShellProps>) {
  useNovuSubscriberSync();
  const bannerRef = useCssVarHeight("--dashboard-banner-height");

  const groups: CollapsibleSidebarGroup[] = useMemo(
    () =>
      nav.groups.map((group) => ({
        ...group,
        items: group.items.map((item) => withBadge(item, badges)),
      })),
    [nav.groups, badges],
  );
  const [collapsed, setCollapsed] = usePersistedCollapse(
    `fw.sidebar.collapsed.${kind}`,
  );
  const toggleSidebar = useCallback(
    () => setCollapsed(!collapsed),
    [collapsed, setCollapsed],
  );
  useSidebarShortcut(toggleSidebar);

  return (
    <NovuProvider>
      {/* Clips the document so a tall page cannot window-scroll the context
          bar away; <main> is the only scrollport. The right panel must NOT be
          overflow-hidden — a second scrollport breaks sticky page chrome. */}
      <div className="flex h-screen-maintenance overflow-hidden bg-zinc-50 dark:bg-zinc-950">
        <div className="hidden h-full shrink-0 md:block">
          <CollapsibleSidebar
            groups={groups}
            basePath={nav.basePath}
            pathname={pathname}
            collapsed={collapsed}
            header={switcher}
          />
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <DashboardContextBar
            {...contextBar}
            leadingSlot={
              <SidebarToggle collapsed={collapsed} onToggle={toggleSidebar} />
            }
            rightSlot={
              <div className="flex shrink-0 items-center gap-1 sm:gap-2">
                {/* Below md the CTA lives in the Menu sheet. */}
                {nav.pinnedCta && (
                  <div className="hidden md:block">
                    <HeaderCta cta={nav.pinnedCta} />
                  </div>
                )}
                <HelpMenu support={nav.support} />
                <NotificationInbox />
                <AccountMenu account={account} onSignOut={onSignOut} />
              </div>
            }
          />

          {/* Feeds --dashboard-banner-height, which .h-dashboard-fill
              subtracts so full-height pages stay inside <main>. */}
          {banner && <div ref={bannerRef}>{banner}</div>}

          {/* `relative` contains absolutely positioned descendants (Radix
              bubble inputs) so none can grow the document. */}
          <main className="relative min-h-0 flex-1 overflow-y-auto">
            {/* Flex column with a viewport floor so editor save bars can pin
                to the bottom via mt-auto. */}
            <div className="flex min-h-full flex-col p-4 sm:p-6 lg:p-8">
              <DashboardErrorBoundary>{children}</DashboardErrorBoundary>
            </div>
          </main>

          {/* In flow at the column's end: always visible, takes real space,
              and <main> needs no compensating padding. */}
          <MobileNav
            basePath={nav.basePath}
            groups={groups}
            settings={nav.settings}
            support={nav.support}
            tabs={nav.mobileTabs}
            pinnedCta={nav.pinnedCta}
            pathname={pathname}
            switcher={switcher}
            onSignOut={onSignOut}
          />
        </div>
      </div>
    </NovuProvider>
  );
}

/** Layout-level loading state matching the shell footprint. */
export function DashboardShellSkeleton() {
  return <CollapsibleSidebarSkeleton />;
}
