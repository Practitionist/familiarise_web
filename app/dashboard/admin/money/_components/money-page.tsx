import type { UserRole } from "@prisma/client";
import { redirect } from "next/navigation";

import { requireUserRole } from "@/lib/auth-guard";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import { findMoneyTab, moneyTabsFor } from "@/lib/backoffice/money-tabs";
import { MoneyTabBody } from "./MoneyTabBody";

/**
 * #1771 K-2 — the shared `[tab]` page of both trees; each section is its own
 * sidebar item. A section the viewer cannot open (unknown, or outside the
 * tree's audience or the viewer's own surfaces) lands on the first section
 * they hold, never on an error boundary (QA #1824).
 */
export async function renderMoneyTab(args: {
  tab: string;
  tree: "admin" | "staff";
  treePath: string;
}) {
  const session = await requireUserRole(["ADMIN", "STAFF"]);
  const role = session.user.role as UserRole;
  const audience: UserRole = args.tree === "admin" ? "ADMIN" : "STAFF";
  const tab = findMoneyTab(args.tab);
  const allowed =
    !!tab &&
    hasBackofficePermission(audience, tab.surface) &&
    hasBackofficePermission(role, tab.surface);
  if (!tab || !allowed) {
    const first = moneyTabsFor(audience).find((t) =>
      hasBackofficePermission(role, t.surface),
    );
    redirect(first ? `${args.treePath}/money/${first.key}` : args.treePath);
  }
  return (
    <MoneyTabBody
      tabKey={tab.key}
      tree={args.tree}
      treePath={args.treePath}
      viewer={{ userId: session.user.id, role: String(role) }}
    />
  );
}
