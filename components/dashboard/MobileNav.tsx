"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Menu } from "lucide-react";

import { cn } from "@/utils/tailwind";
import { LinkPendingIcon } from "@/components/ui/NavLink";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  SidebarNavGroups,
  SidebarNavLink,
  formatNavBadge,
  type CollapsibleSidebarGroup,
  type CollapsibleSidebarItem,
} from "@/components/dashboard/CollapsibleSidebar";
import {
  AccountRow,
  PinnedCtaButton,
  type DashboardAccount,
} from "@/components/dashboard/DashboardShellParts";
import { isActiveRoute } from "@/components/dashboard/route-active";
import type { PinnedCta } from "@/lib/dashboard/nav/types";

export interface MobileNavProps {
  basePath: string;
  groups: CollapsibleSidebarGroup[];
  utility: CollapsibleSidebarItem[];
  /** Paths of up to four items shown as tabs. */
  tabs: string[];
  pinnedCta?: PinnedCta;
  pathname: string;
  switcher: ReactNode;
  account: DashboardAccount;
  onSignOut: () => void;
}

const TAB_CLASS =
  "relative flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors";

/**
 * Phone navigation for every shell (#1527 §6): up to four tabs plus Menu,
 * which opens a bottom sheet holding the switcher, the full grouped nav, the
 * utility links, the pinned CTA and the account block with Sign out — so no
 * destination is unreachable below md. Exactly h-16: `.h-dashboard-fill`
 * budgets 4rem for this bar, so no safe-area padding is added here.
 */
export function MobileNav({
  basePath,
  groups,
  utility,
  tabs,
  pinnedCta,
  pathname,
  switcher,
  account,
  onSignOut,
}: Readonly<MobileNavProps>) {
  // Keyed to the pathname it opened on, so any navigation — including a
  // switcher facet — closes the sheet without an effect.
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const open = openedAt === pathname;
  const setOpen = (next: boolean) => setOpenedAt(next ? pathname : null);
  const close = () => setOpen(false);

  const items = [...groups.flatMap((g) => g.items), ...utility];
  const tabItems = tabs
    .map((path) => items.find((item) => item.path === path))
    .filter((item): item is CollapsibleSidebarItem => !!item)
    .slice(0, 4);
  const onTab = tabItems.some((item) =>
    isActiveRoute(pathname, basePath, item.path),
  );

  return (
    <nav
      aria-label="Dashboard"
      className="flex h-16 shrink-0 border-t border-zinc-200 bg-white md:hidden dark:border-zinc-800 dark:bg-zinc-900"
    >
      {tabItems.map((item) => {
        const active = isActiveRoute(pathname, basePath, item.path);
        const badge = formatNavBadge(item.badge);
        return (
          <Link
            key={item.path}
            href={`${basePath}/${item.path}`}
            aria-current={active ? "page" : undefined}
            className={cn(
              TAB_CLASS,
              active
                ? "text-zinc-900 dark:text-zinc-100"
                : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200",
            )}
          >
            <span className="relative">
              <LinkPendingIcon
                Icon={item.icon}
                className={cn(
                  "h-5 w-5",
                  active
                    ? "text-zinc-900 dark:text-zinc-100"
                    : "text-zinc-400 dark:text-zinc-500",
                )}
              />
              {badge && (
                <span className="absolute -right-2.5 -top-1.5 min-w-[16px] rounded-full bg-red-500 px-1 text-center text-[9px] font-semibold leading-4 text-white">
                  {badge}
                  <span className="sr-only"> new</span>
                </span>
              )}
            </span>
            <span className="max-w-full truncate px-1">{item.name}</span>
          </Link>
        );
      })}

      <Sheet open={open} onOpenChange={setOpen}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={open}
          aria-haspopup="dialog"
          className={cn(
            TAB_CLASS,
            onTab
              ? "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
              : "text-zinc-900 dark:text-zinc-100",
          )}
        >
          <Menu className="h-5 w-5" />
          <span>Menu</span>
        </button>
        <SheetContent
          side="bottom"
          className="space-y-4 px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-2"
        >
          <SheetTitle className="sr-only">Menu</SheetTitle>
          <SheetDescription className="sr-only">
            Switch dashboard, navigate, or sign out.
          </SheetDescription>
          <div className="pr-8">{switcher}</div>
          <SidebarNavGroups
            groups={groups}
            basePath={basePath}
            pathname={pathname}
            onNavigate={close}
          />
          {(utility.length > 0 || pinnedCta) && (
            <div className="space-y-1 border-t border-zinc-200 pt-3 dark:border-zinc-800">
              {utility.map((item) => (
                <SidebarNavLink
                  key={item.path}
                  item={item}
                  basePath={basePath}
                  pathname={pathname}
                  onNavigate={close}
                />
              ))}
              {pinnedCta && (
                <PinnedCtaButton cta={pinnedCta} onNavigate={close} />
              )}
            </div>
          )}
          <div className="border-t border-zinc-200 pt-3 dark:border-zinc-800">
            <AccountRow
              account={account}
              onSignOut={onSignOut}
              onNavigate={close}
            />
          </div>
        </SheetContent>
      </Sheet>
    </nav>
  );
}
