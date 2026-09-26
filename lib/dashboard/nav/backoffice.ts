import {
  buildBackofficeNav,
  type BackofficeNavOptions,
} from "@/lib/dashboard/backoffice-nav";
import type { BackofficeCapability } from "@/lib/backoffice/capability";

import type { DashboardNav } from "./types";

// #1527 Q12 — staff land on Tickets, so their tabs lead with the queues.
const MOBILE_TABS: Record<BackofficeCapability["tree"], string[]> = {
  admin: ["home", "tickets", "appointments", "money/payments"],
  staff: ["tickets", "threads", "appointments", "users"],
};

/** Adapts `buildBackofficeNav` to the shared shell (#1527). */
export function buildBackofficeDashboardNav(
  cap: BackofficeCapability,
  options: BackofficeNavOptions = {},
): DashboardNav {
  const groups = buildBackofficeNav(cap, options);
  const paths = new Set(groups.flatMap((g) => g.items.map((i) => i.path)));
  return {
    basePath: cap.basePath,
    groups,
    utility: [],
    mobileTabs: MOBILE_TABS[cap.tree].filter((p) => paths.has(p)),
  };
}
