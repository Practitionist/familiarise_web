import { notFound } from "next/navigation";

import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import { findMoneyTab } from "@/lib/backoffice/money-tabs";
import { renderMoneyTab } from "@/app/dashboard/admin/money/_components/money-page";

/** #1771 K-2 — one Money hub tab in the staff tree; admin-only tabs 404 here. */
export default async function StaffMoneyTabPage({
  params,
}: Readonly<{ params: Promise<{ staffId: string; tab: string }> }>) {
  const { staffId, tab } = await params;
  const known = findMoneyTab(tab);
  if (!known || !hasBackofficePermission("STAFF", known.surface)) notFound();
  return renderMoneyTab({
    tab,
    tree: "staff",
    treePath: `/dashboard/staff/${staffId}`,
  });
}
