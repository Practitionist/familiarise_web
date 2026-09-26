import { renderMoneyTab } from "@/components/dashboard/backoffice/money/money-page";

/**
 * #1771 K-2 — one money section in the staff tree; an admin-only section
 * (earnings, reconcile) redirects to the first staff section instead of erroring.
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
