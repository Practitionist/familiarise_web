import { notFound, redirect } from "next/navigation";

import { requireUserRole } from "@/lib/auth-guard";
import {
  backofficeLandingHref,
  can,
  isBackofficeTree,
  resolveBackofficeCapability,
} from "@/lib/backoffice/capability";
import { findMoneyTab, moneyTabsFor } from "@/lib/backoffice/money-tabs";
import { MoneyTabBody } from "./MoneyTabBody";

/**
 * The shared `[tab]` page of both trees; each section is its own sidebar item.
 * An unknown section 404s; a known one the viewer cannot open lands on the
 * first section they hold.
 */
export async function renderMoneyTab(args: {
  tab: string;
  tree: string;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  if (!isBackofficeTree(args.tree)) notFound();
  const treePath = `/dashboard/${args.tree}`;
  const session = await requireUserRole(["ADMIN", "STAFF"]);
  const cap = resolveBackofficeCapability(session.user.role, args.tree);
  if (!cap) redirect("/dashboard");
  const tab = findMoneyTab(args.tab);
  if (!tab) notFound();
  if (!can(cap, tab.surface)) {
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
      searchParams={args.searchParams}
    />
  );
}
