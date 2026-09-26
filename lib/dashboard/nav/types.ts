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

export interface NavGroup {
  /** Omitted for the headerless top cluster. */
  label?: string;
  items: NavItem[];
  defaultCollapsed?: boolean;
}

export interface PinnedCta {
  label: string;
  /** Absolute app path or external URL — NOT relative to basePath. */
  href: string;
  icon: LucideIcon;
  external?: boolean;
  /** When set, a copy-link affordance copies this (app paths get the origin). */
  copyText?: string;
}

export interface DashboardNav {
  basePath: string;
  groups: NavGroup[];
  /** Help & support / Settings — rendered under the grouped nav (#1527 §13). */
  utility: NavItem[];
  /** Up to four item paths shown as mobile tabs; everything else is in Menu. */
  mobileTabs: string[];
  pinnedCta?: PinnedCta;
}

/** Every item in a nav, groups first, then utility. */
export function flattenNav(nav: Pick<DashboardNav, "groups" | "utility">) {
  return [...nav.groups.flatMap((g) => g.items), ...nav.utility];
}
