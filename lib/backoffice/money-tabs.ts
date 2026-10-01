import type { UserRole } from "@prisma/client";

import {
  hasBackofficePermission,
  type BackofficeSurface,
} from "@/lib/auth/backoffice-permissions";

/**
 * #1771 K-2 — the money sections, one URL each under `<tree>/money/<key>`.
 * The sidebar lists each one as its own item, and both the sidebar and the
 * page guard filter this list through BACKOFFICE_PERMISSIONS, so a section is
 * never shown to a role whose page guard would then turn it away.
 */
export type MoneyTabKey =
  | "payments"
  | "refunds"
  | "disputes"
  | "payouts"
  | "earnings"
  | "reconcile"
  | "audit";

export interface MoneyTab {
  key: MoneyTabKey;
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
    key: "disputes",
    label: "Disputes",
    description: "Chargebacks and their evidence deadlines.",
    surface: "disputes.read",
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
    // The section is the hold/release doors, so admin; the earnings read
    // itself follows `payouts.read` (the Payouts board's Earnings view).
    surface: "payouts.manage",
  },
  {
    key: "reconcile",
    label: "Reconcile",
    description: "Run the reconcile jobs now and see when each last ran.",
    surface: "payouts.manage",
  },
];

/**
 * The console's audit log keeps its `/money/audit` URL, but the sidebar lists
 * it as its own item at the end, outside the Money group.
 */
export const AUDIT_TAB: MoneyTab = {
  key: "audit",
  label: "Audit log",
  description: "Every console action: who, what, on which row, and why.",
  surface: "opsLog.read",
};

export function moneyTabsFor(audience: UserRole): MoneyTab[] {
  return MONEY_TABS.filter((t) => hasBackofficePermission(audience, t.surface));
}

export function findMoneyTab(key: string): MoneyTab | undefined {
  return [...MONEY_TABS, AUDIT_TAB].find((t) => t.key === key);
}

/**
 * A retired section's new home, answered with a 308: the class-series doors
 * moved onto each class booking's Ops actions panel under Appointments.
 */
export function retiredMoneyTabHref(
  treePath: string,
  key: string,
): string | null {
  if (key === "class-series") return `${treePath}/appointments?type=class`;
  return null;
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
