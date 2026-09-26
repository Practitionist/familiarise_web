"use client";

import { useMemo, type ReactNode } from "react";

import { useCssVarHeight } from "@/components/dashboard/useCssVarHeight";
import {
  CollapsibleSidebar,
  CollapsibleSidebarSkeleton,
  SidebarNavLink,
  useSidebarCollapsed,
  type CollapsibleSidebarGroup,
  type CollapsibleSidebarItem,
} from "@/components/dashboard/CollapsibleSidebar";
import {
  DashboardContextBar,
  type DashboardContextBarProps,
} from "@/components/dashboard/DashboardContextBar";
import {
  AccountChip,
  PinnedCtaButton,
  type DashboardAccount,
} from "@/components/dashboard/DashboardShellParts";
import { MobileNav } from "@/components/dashboard/MobileNav";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { TooltipProvider } from "@/components/ui/tooltip";
import NovuProvider from "@/providers/NovuProvider";
import { useNovuSubscriberSync } from "@/hooks/useNovuSubscriberSync";
import type {
  DashboardNav,
  NavItem,
  PinnedCta,
} from "@/lib/dashboard/nav/types";

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
  account: DashboardAccount;
  onSignOut: () => void;
  contextBar: DashboardContextBarProps;
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

function SidebarFooter({
  basePath,
  pathname,
  utility,
  pinnedCta,
  account,
  onSignOut,
}: Readonly<{
  basePath: string;
  pathname: string;
  utility: CollapsibleSidebarItem[];
  pinnedCta?: PinnedCta;
  account: DashboardAccount;
  onSignOut: () => void;
}>) {
  const collapsed = useSidebarCollapsed();
  return (
    <TooltipProvider delayDuration={0}>
      {utility.map((item) => (
        <SidebarNavLink
          key={item.path}
          item={item}
          basePath={basePath}
          pathname={pathname}
          collapsed={collapsed}
        />
      ))}
      {pinnedCta && <PinnedCtaButton cta={pinnedCta} collapsed={collapsed} />}
      <AccountChip
        account={account}
        onSignOut={onSignOut}
        collapsed={collapsed}
      />
    </TooltipProvider>
  );
}

/**
 * The one dashboard chrome (#1527 §6), shared by the personal, organization,
 * workspace and back-office trees:
 *
 *   ┌ sidebar (md+) ─┬ context bar (sticky h-14) ┐
 *   │ switcher       ├ banner slot               │
 *   │ grouped nav    ├ main (error boundary)     │
 *   │ utility · CTA  │                           │
 *   │ account chip   ├ mobile tabs + Menu (<md)  │
 *   └────────────────┴───────────────────────────┘
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
  const utility = useMemo(
    () => nav.utility.map((item) => withBadge(item, badges)),
    [nav.utility, badges],
  );

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
            storageKey={`fw.sidebar.collapsed.${kind}`}
            header={switcher}
            footer={
              <SidebarFooter
                basePath={nav.basePath}
                pathname={pathname}
                utility={utility}
                pinnedCta={nav.pinnedCta}
                account={account}
                onSignOut={onSignOut}
              />
            }
          />
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <DashboardContextBar {...contextBar} />

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
            utility={utility}
            tabs={nav.mobileTabs}
            pinnedCta={nav.pinnedCta}
            pathname={pathname}
            switcher={switcher}
            account={account}
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
