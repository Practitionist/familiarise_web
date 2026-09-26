import {
  buildBackofficeNav,
  type BackofficeNavOptions,
} from "@/lib/dashboard/backoffice-nav";

import type { DashboardNav } from "./types";

// Builder (d) refines these with the tree merge; each must be a nav item.
const MOBILE_TABS: Record<"admin" | "staff", string[]> = {
  admin: ["home", "tickets", "appointments", "money/payments"],
  staff: ["home", "tickets", "appointments", "users"],
};

/** Adapts `buildBackofficeNav` (API unchanged) to the shared shell (#1527). */
export function buildBackofficeDashboardNav(
  tree: "admin" | "staff",
  basePath: string,
  options: BackofficeNavOptions = {},
): DashboardNav {
  const groups = buildBackofficeNav(tree, options);
  const paths = new Set(groups.flatMap((g) => g.items.map((i) => i.path)));
  return {
    basePath,
    groups,
    utility: [],
    mobileTabs: MOBILE_TABS[tree].filter((p) => paths.has(p)),
  };
}
