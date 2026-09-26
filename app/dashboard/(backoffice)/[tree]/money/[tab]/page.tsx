import { renderMoneyTab } from "@/components/dashboard/backoffice/money/money-page";

/** #1771 K-2 — one money section in the admin tree. */
export default async function AdminMoneyTabPage({
  params,
}: Readonly<{ params: Promise<{ tab: string }> }>) {
  const { tab } = await params;
  return renderMoneyTab({ tab, tree: "admin", treePath: "/dashboard/admin" });
}
