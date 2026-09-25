import type { UserRole } from "@prisma/client";

import {
  hasBackofficePermission,
  type BackofficeSurface,
} from "@/lib/auth/backoffice-permissions";

/**
 * #1771 K-2 — the Money hub's tabs, one URL each under `<tree>/money/<key>`.
 * Both trees read this list and filter it through BACKOFFICE_PERMISSIONS, so
 * a tab is never shown to a role whose page guard would then turn it away.
 */
export interface MoneyTab {
  key: string;
  label: string;
  description: string;
  surface: BackofficeSurface;
}

export const MONEY_TABS: readonly MoneyTab[] = [
  {
    key: "payments",
    label: "Payments",
    description: "Every payment, with its status and rail.",
    surface: "payments.read",
  },
  {
    key: "refunds",
    label: "Refunds",
    description: "Refunds issued, pending and failed.",
    surface: "refunds.read",
  },
  {
    key: "payouts",
    label: "Payouts",
    description: "Consultant payouts waiting, in flight and paid.",
    surface: "payouts.read",
  },
  {
    key: "earnings",
    label: "Earnings",
    description: "Consultant earnings, with hold and release.",
    surface: "payouts.read",
  },
  {
    key: "disputes",
    label: "Disputes",
    description: "Chargebacks and their evidence deadlines.",
    surface: "disputes.read",
  },
  {
    key: "reconcile",
    label: "Reconcile",
    description: "Run the reconcile jobs now and see when each last ran.",
    surface: "payouts.manage",
  },
  {
    key: "class-series",
    label: "Class series",
    description:
      "The manual doors for class series: sessions, make-ups, seats.",
    surface: "classSeries.support",
  },
  {
    key: "audit",
    label: "Audit",
    description: "Every console action: who, what, on which row, and why.",
    surface: "opsLog.read",
  },
];

export function moneyTabsFor(audience: UserRole): MoneyTab[] {
  return MONEY_TABS.filter((t) => hasBackofficePermission(audience, t.surface));
}

export function findMoneyTab(key: string): MoneyTab | undefined {
  return MONEY_TABS.find((t) => t.key === key);
}

type SearchParams = Record<string, string | string[] | undefined>;

/** The hub URL a retired money page answers with, its query carried over. */
export function moneyHubHref(
  treePath: string,
  tabKey: string,
  searchParams: SearchParams = {},
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v !== undefined) query.append(key, v);
    }
  }
  const qs = query.toString();
  const suffix = qs ? `?${qs}` : "";
  return `${treePath}/money/${tabKey}${suffix}`;
}
