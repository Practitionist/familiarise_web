import { notFound } from "next/navigation";

import { requireBackofficePage } from "@/lib/auth-guard";
import { findMoneyTab } from "@/lib/backoffice/money-tabs";
import { MoneyTabBody } from "./MoneyTabBody";

/**
 * #1771 K-2 — the shared `[tab]` page of both trees: an unknown tab is a 404,
 * and a known one re-checks its own surface (the strip hiding it is cosmetic).
 */
export async function renderMoneyTab(args: {
  tab: string;
  tree: "admin" | "staff";
  treePath: string;
}) {
  const tab = findMoneyTab(args.tab);
  if (!tab) notFound();
  const session = await requireBackofficePage(tab.surface);
  return (
    <MoneyTabBody
      tabKey={tab.key}
      tree={args.tree}
      treePath={args.treePath}
      viewer={{ userId: session.user.id, role: String(session.user.role) }}
    />
  );
}
