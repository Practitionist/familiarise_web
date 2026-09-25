import type { ReactNode } from "react";

import { moneyTabsFor } from "@/lib/backoffice/money-tabs";
import { MoneyHubNav } from "@/app/dashboard/admin/money/_components/MoneyHubNav";

/**
 * #1771 K-2 — the same Money hub in the staff tree, reduced to the tabs STAFF
 * hold (payouts and earnings are ADMIN_ONLY), even for an admin viewing it.
 */
export default async function StaffMoneyLayout({
  children,
  params,
}: Readonly<{ children: ReactNode; params: Promise<{ staffId: string }> }>) {
  const { staffId } = await params;
  const tabs = moneyTabsFor("STAFF").map(({ key, label }) => ({ key, label }));
  return (
    <>
      <MoneyHubNav basePath={`/dashboard/staff/${staffId}/money`} tabs={tabs} />
      <div className="min-w-0">{children}</div>
    </>
  );
}
