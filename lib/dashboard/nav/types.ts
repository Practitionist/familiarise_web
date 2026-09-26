import type { LucideIcon } from "lucide-react";

/**
 * Shared nav contract for every dashboard shell (#1527). Builders under
 * `lib/dashboard/nav/` are pure: no JSX, no Tailwind, so tests import them and
 * assert every href resolves to a real page instead of regex-scanning layouts.
 */

/** Keys into the shell's `badges` map (unread messages, pending requests, …). */
export type NavBadgeKey = string;

export interface NavItem {
  name: string;
  icon: LucideIcon;
  /** Path relative to the nav's `basePath` (may contain a `/`). */
  path: string;
  badgeKey?: NavBadgeKey;
}

/** A plain, always-open section; the label is a caption, not a toggle (#1527). */
export interface NavGroup {
  /** Omitted for the headerless top cluster. */
  label?: string;
  items: NavItem[];
}

export interface PinnedCta {
  label: string;
  /** Absolute app path or external URL — NOT relative to basePath. */
  href: string;
  icon: LucideIcon;
  /** Opens in a new tab (the expert's public page keeps the dashboard open). */
  external?: boolean;
  /** When set, a copy-link affordance copies this (app paths get the origin). */
  copyText?: string;
}

export interface DashboardNav {
  basePath: string;
  groups: NavGroup[];
  /** The one Settings row at the rail's bottom (#1527 Cloudflare shell). */
  settings: NavItem;
  /** Header "Help & support" target — an absolute app path. */
  helpHref: string;
  /** Up to four item paths shown as mobile tabs; everything else is in Menu. */
  mobileTabs: string[];
  /** Header button beside Help (#1527) — never a sidebar row. */
  pinnedCta?: PinnedCta;
}

/** Every item in a nav, groups first, then Settings. */
export function flattenNav(nav: Pick<DashboardNav, "groups" | "settings">) {
  return [...nav.groups.flatMap((g) => g.items), nav.settings];
}
