import { PaymentsPage } from "@/components/dashboard/shared/PaymentsPage";
import { RefundsPage } from "@/components/dashboard/shared/RefundsPage";
import { DisputesPage } from "@/components/dashboard/shared/DisputesPage";
import { PayoutsBoard } from "@/components/dashboard/backoffice/payouts/PayoutsBoard";
import { EarningsTab } from "./EarningsTab";
import { RefundDoorsPanel } from "./RefundsTab";
import { ReconcileTab } from "./ReconcileTab";
import { AuditTab } from "./AuditTab";
import { readOpsLog } from "@/lib/backoffice/ops-log-read";

/**
 * #1771 K-2 — one tab's body. Each mounts the page component that already
 * served the old URL, so the hub moves the pages without rewriting them.
 * `treePath` keeps each page's own detail links inside its tree.
 */
export async function MoneyTabBody({
  tabKey,
  tree,
  treePath,
  viewer,
}: Readonly<{
  tabKey: string;
  tree: "admin" | "staff";
  treePath: string;
  viewer: { userId: string; role: string };
}>) {
  const isAdmin = tree === "admin";
  switch (tabKey) {
    case "payments":
      return <PaymentsPage basePath={treePath} />;
    case "refunds":
      return (
        <>
          {isAdmin && <RefundDoorsPanel />}
          <RefundsPage
            basePath={treePath}
            apiEndpoint="/api/admin/refunds"
            title="Refunds"
            description={
              isAdmin
                ? "Manage and view all payment refunds"
                : "View and track refund requests"
            }
            queryKeyPrefix={isAdmin ? "admin-refunds" : "staff-refunds"}
          />
        </>
      );
    case "payouts":
      return <PayoutsBoard canManage={isAdmin} />;
    case "earnings":
      return <EarningsTab />;
    case "disputes":
      return (
        <DisputesPage
          basePath={treePath}
          apiEndpoint="/api/admin/disputes"
          title="Disputes"
          description={
            isAdmin
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
          viewerIsAdmin={viewer.role === "ADMIN"}
        />
      );
    default:
      return null;
  }
}
