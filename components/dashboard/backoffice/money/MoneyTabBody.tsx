import { PaymentsPage } from "@/components/dashboard/shared/PaymentsPage";
import { RefundsPage } from "@/components/dashboard/shared/RefundsPage";
import { DisputesPage } from "@/components/dashboard/shared/DisputesPage";
import { PayoutsBoard } from "@/components/dashboard/backoffice/payouts/PayoutsBoard";
import { EarningsTab } from "./EarningsTab";
import { OrgPayoutsTab } from "./OrgPayoutsTab";
import { RefundDoorsPanel } from "./RefundsTab";
import { ReconcileTab } from "./ReconcileTab";
import { IncidentsTab } from "./IncidentsTab";
import { ApprovalsTab } from "./ApprovalsTab";
import { AuditTab } from "./AuditTab";
import { SupportSpendTab } from "./SupportSpendTab";
import { readOpsLog } from "@/lib/backoffice/ops-log-read";
import { readSupportSpend } from "@/lib/backoffice/support-spend";
import { can, type BackofficeCapability } from "@/lib/backoffice/capability";
import {
  disputeStatusParam,
  earningsExpertParam,
  paymentStatusParam,
  refundStatusParam,
} from "@/lib/backoffice/money-list-schemas";
import { opsLogFiltersFromSearchParams } from "@/schemas/ops-log";

/**
 * #1771 K-2 — one tab's body. Each mounts the page component that already
 * served the old URL, so the hub moves the pages without rewriting them.
 * Detail links read the tree from the capability context (#1527).
 */
export async function MoneyTabBody({
  tabKey,
  cap,
  viewer,
  searchParams,
}: Readonly<{
  tabKey: string;
  cap: BackofficeCapability;
  viewer: { userId: string; role: string };
  searchParams: Record<string, string | string[] | undefined>;
}>) {
  switch (tabKey) {
    // Each list opens on the status its link names; a new status remounts it.
    case "payments": {
      const status = paymentStatusParam.parse(searchParams.status);
      return <PaymentsPage key={status ?? "all"} initialStatus={status} />;
    }
    case "refunds": {
      const status = refundStatusParam.parse(searchParams.status);
      return (
        <RefundsPage
          key={status ?? "all"}
          initialStatus={status}
          apiEndpoint="/api/admin/refunds"
          title="Refunds"
          description={
            can(cap, "refunds.manage")
              ? "Manage and view all payment refunds"
              : "View and track refund requests"
          }
          queryKeyPrefix={`${cap.tree}-refunds`}
          beforeContent={
            can(cap, "refunds.manage") ? <RefundDoorsPanel /> : undefined
          }
        />
      );
    }
    case "payouts":
      return <PayoutsBoard />;
    case "org-payouts":
      return <OrgPayoutsTab />;
    case "earnings":
      return (
        <EarningsTab
          initialConsultantProfileId={earningsExpertParam.parse(
            searchParams.consultantProfileId,
          )}
        />
      );
    case "disputes": {
      const status = disputeStatusParam.parse(searchParams.status);
      return (
        <DisputesPage
          key={status ?? "all"}
          initialStatus={status}
          apiEndpoint="/api/admin/disputes"
          title="Disputes"
          description={
            can(cap, "disputes.manage")
              ? "Manage and respond to payment disputes"
              : "View and track payment disputes"
          }
        />
      );
    }
    case "reconcile":
      return <ReconcileTab />;
    case "approvals":
      return <ApprovalsTab viewerId={viewer.userId} />;
    case "incidents":
      return <IncidentsTab canDeclare={can(cap, "incidents.declare")} />;
    case "support-spend":
      return (
        <SupportSpendTab
          initial={await readSupportSpend({ viewer, now: new Date() })}
        />
      );
    case "audit": {
      // #1771 K-9 — RSC-seeded: the first page ships with the HTML.
      const filters = opsLogFiltersFromSearchParams(searchParams);
      return (
        <AuditTab
          // A new filtered link remounts the tab with its own seed.
          key={JSON.stringify(filters)}
          initial={await readOpsLog({ viewer, filters, page: 1 })}
          initialFilters={filters}
        />
      );
    }
    default:
      return null;
  }
}
