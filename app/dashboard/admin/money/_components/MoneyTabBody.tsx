import { PaymentsPage } from "@/components/dashboard/shared/PaymentsPage";
import { RefundsPage } from "@/components/dashboard/shared/RefundsPage";
import { DisputesPage } from "@/components/dashboard/shared/DisputesPage";
import { PayoutsBoard } from "@/app/dashboard/admin/payouts/PayoutsBoard";
import { EarningsTab } from "./EarningsTab";
import { RefundDoorsPanel } from "./RefundsTab";
import { ClassSeriesTab } from "./ClassSeriesTab";

/**
 * #1771 K-2 — one tab's body. Each mounts the page component that already
 * served the old URL, so the hub moves the pages without rewriting them.
 * `treePath` keeps each page's own detail links inside its tree.
 */
export function MoneyTabBody({
  tabKey,
  tree,
  treePath,
}: Readonly<{ tabKey: string; tree: "admin" | "staff"; treePath: string }>) {
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
      return <PayoutsBoard />;
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
    case "class-series":
      return <ClassSeriesTab isAdmin={isAdmin} />;
    default:
      return null;
  }
}
