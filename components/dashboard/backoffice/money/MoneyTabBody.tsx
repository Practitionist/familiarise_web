import { PaymentsPage } from "@/components/dashboard/shared/PaymentsPage";
import { RefundsPage } from "@/components/dashboard/shared/RefundsPage";
import { DisputesPage } from "@/components/dashboard/shared/DisputesPage";
import { PayoutsBoard } from "@/components/dashboard/backoffice/payouts/PayoutsBoard";
import { EarningsTab } from "./EarningsTab";
import { RefundDoorsPanel } from "./RefundsTab";
import { ReconcileTab } from "./ReconcileTab";
import { AuditTab } from "./AuditTab";
import { readOpsLog } from "@/lib/backoffice/ops-log-read";
import { can, type BackofficeCapability } from "@/lib/backoffice/capability";

/**
 * #1771 K-2 — one tab's body. Each mounts the page component that already
 * served the old URL, so the hub moves the pages without rewriting them.
 * Detail links read the tree from the capability context (#1527).
 */
export async function MoneyTabBody({
  tabKey,
  cap,
  viewer,
}: Readonly<{
  tabKey: string;
  cap: BackofficeCapability;
  viewer: { userId: string; role: string };
}>) {
  switch (tabKey) {
    case "payments":
      return <PaymentsPage />;
    case "refunds":
      return (
        <>
          {can(cap, "refunds.manage") && <RefundDoorsPanel />}
          <RefundsPage
            apiEndpoint="/api/admin/refunds"
            title="Refunds"
            description={
              can(cap, "refunds.manage")
                ? "Manage and view all payment refunds"
                : "View and track refund requests"
            }
            queryKeyPrefix={`${cap.tree}-refunds`}
          />
        </>
      );
    case "payouts":
      return <PayoutsBoard />;
    case "earnings":
      return <EarningsTab />;
    case "disputes":
      return (
        <DisputesPage
          apiEndpoint="/api/admin/disputes"
          title="Disputes"
          description={
            can(cap, "disputes.manage")
              ? "Manage and respond to payment disputes"
              : "View and track payment disputes"
          }
        />
      );
    case "reconcile":
      return <ReconcileTab />;
    case "audit":
      // #1771 K-9 — RSC-seeded: the first page ships with the HTML.
      return (
        <AuditTab
          initial={await readOpsLog({ viewer, filters: {}, page: 1 })}
        />
      );
    default:
      return null;
  }
}
