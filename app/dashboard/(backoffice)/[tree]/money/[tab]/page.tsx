import { renderMoneyTab } from "@/components/dashboard/backoffice/money/money-page";

/** #1771 K-2 — one money section, in either tree. */
export default async function BackofficeMoneyTabPage({
  params,
}: Readonly<{ params: Promise<{ tree: string; tab: string }> }>) {
  const { tree, tab } = await params;
  return renderMoneyTab({ tab, tree });
}
