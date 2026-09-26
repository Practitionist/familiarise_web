import { renderMoneyTab } from "@/app/dashboard/admin/money/_components/money-page";

/**
 * #1771 K-2 — one Money hub tab in the staff tree; an admin-only tab (payouts,
 * earnings, reconcile) redirects to the first staff tab instead of erroring.
 */
export default async function StaffMoneyTabPage({
  params,
}: Readonly<{ params: Promise<{ staffId: string; tab: string }> }>) {
  const { staffId, tab } = await params;
  return renderMoneyTab({
    tab,
    tree: "staff",
    treePath: `/dashboard/staff/${staffId}`,
  });
}
