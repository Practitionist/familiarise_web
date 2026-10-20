import type { LucideIcon } from "lucide-react";

/**
 * Shared nav contract for every dashboard shell (#1527). Builders under
 * `lib/dashboard/nav/` are pure: no JSX, no Tailwind, so tests import them and
 * assert every href resolves to a real page instead of regex-scanning layouts.
 */

export interface NavItem {
  name: string;
  icon: LucideIcon;
  /** Path relative to the nav's `basePath` (may contain a `/`). */
  path: string;
  /** Key into the shell's `badges` map (unread messages, pending requests, …). */
  badgeKey?: string;
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

/**
 * The header Help menu's private rows (#1527). The Help Center (`/support`)
 * is always there; these point at the viewer's own Support requests page.
 */
export interface SupportLinks {
  requestsHref: string;
  /** The separate product feedback page, when available. */
  feedbackHref: string | null;
}

/** Personal help destinations share an area, not a support conversation. */
export function personalSupportLinks(requestsHref: string): SupportLinks {
  return { requestsHref, feedbackHref: `${requestsHref}/feedback` };
}

export interface DashboardNav {
  basePath: string;
  groups: NavGroup[];
  /** Help menu rows; null leaves only the Help Center (back office). */
  support: SupportLinks | null;
  /** Up to four item paths shown as mobile tabs; everything else is in Menu. */
  mobileTabs: string[];
  /** Header button beside Help (#1527) — never a sidebar row. */
  pinnedCta?: PinnedCta;
}

/** Every destination appears once in its sidebar group. */
export function flattenNav(nav: Pick<DashboardNav, "groups">): NavItem[] {
  return nav.groups.flatMap((g) => g.items);
}
