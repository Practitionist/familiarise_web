import type { ReactNode } from "react";

import { moneyTabsFor } from "@/lib/backoffice/money-tabs";
import { MoneyHubNav } from "./_components/MoneyHubNav";

/**
 * #1771 K-2 — the Money hub: one tab strip over the money pages, a URL per
 * tab. The admin layout above already admits ADMIN only.
 */
export default function AdminMoneyLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const tabs = moneyTabsFor("ADMIN").map(({ key, label }) => ({ key, label }));
  return (
    <>
      <MoneyHubNav basePath="/dashboard/admin/money" tabs={tabs} />
      <div className="min-w-0">{children}</div>
    </>
  );
}
