import { notFound, permanentRedirect, redirect } from "next/navigation";

import { requireUserRole } from "@/lib/auth-guard";
import {
  backofficeLandingHref,
  can,
  isBackofficeTree,
  resolveBackofficeCapability,
} from "@/lib/backoffice/capability";
import {
  findMoneyTab,
  moneyTabsFor,
  retiredMoneyTabHref,
} from "@/lib/backoffice/money-tabs";
import { MoneyTabBody } from "./MoneyTabBody";

/**
 * #1771 K-2 — the shared `[tab]` page of both trees; each section is its own
 * sidebar item. A section the viewer cannot open (unknown, or outside the
 * tree's audience or the viewer's own surfaces) lands on the first section
 * they hold, never on an error boundary (QA #1824).
 */
export async function renderMoneyTab(args: { tab: string; tree: string }) {
  if (!isBackofficeTree(args.tree)) notFound();
  const treePath = `/dashboard/${args.tree}`;
  const retired = retiredMoneyTabHref(treePath, args.tab);
  if (retired) permanentRedirect(retired);
  const session = await requireUserRole(["ADMIN", "STAFF"]);
  const cap = resolveBackofficeCapability(session.user.role, args.tree);
  if (!cap) redirect("/dashboard");
  const tab = findMoneyTab(args.tab);
  if (!tab || !can(cap, tab.surface)) {
    const first = moneyTabsFor(cap.audience).find((t) => can(cap, t.surface));
    redirect(
      first ? `${treePath}/money/${first.key}` : backofficeLandingHref(cap),
    );
  }
  return (
    <MoneyTabBody
      tabKey={tab.key}
      cap={cap}
      viewer={{ userId: session.user.id, role: String(cap.role) }}
    />
  );
}
