"use client";

import { useQuery } from "@tanstack/react-query";
import { FileText, Lock } from "lucide-react";

import { useOrgRole, useRequireOrgAccess } from "../useOrgRole";
import {
  fetchOrgDetails,
  orgDetailsQueryKey,
} from "@/lib/api/organizations/org-details";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { UrlTabs } from "@/components/dashboard/UrlTabs";
import { CreateTicketDialog } from "@/components/dashboard/shared/support/CreateTicketDialog";
import { BillingBlockBanner } from "@/components/billing/BillingBlockBanner";
import { Button } from "@/components/ui/button";
import type { OrgReceivablesPayload } from "@/lib/data/org-receivables";

import { fetchBilling } from "./billing-api";
import { InvoicesPanel } from "./InvoicesPanel";
import { AccruedUsagePanel } from "./AccruedUsagePanel";
import { LicensePanel } from "./LicensePanel";
import { WalletTab } from "./WalletTab";
import { PurchaseOrdersPanel } from "../purchase-orders/PurchaseOrdersPanel";
import { DisputesPanel } from "../disputes/DisputesPanel";
import { MemberSpendPanel } from "../reimbursements/MemberSpendPanel";

function moneyBlockReason(opts: {
  walletFrozen: boolean;
  walletFrozenReason: string | null | undefined;
  dunningSuspended: boolean;
  orgStatus: string | undefined;
}): string {
  if (opts.walletFrozen) {
    return opts.walletFrozenReason ?? "Wallet spend is frozen";
  }
  if (opts.dunningSuspended) {
    return "Bookings are paused until the overdue invoice is settled";
  }
  if (opts.orgStatus === "SUSPENDED") return "Organization suspended";
  return "Verify your organization to move money";
}

/**
 * Org Billing (#1527 Q7): every money tab the org's funding shape uses, one
 * page. Purchase orders, disputes and member spend used to be sidebar items;
 * each tab now shows only when the funding source, flags and the viewer's
 * permissions make it meaningful. Q8: orgs no longer compose invoices here —
 * "Request an invoice" asks the platform, which issues it from the backoffice.
 */
export function BillingPageClient({
  orgId,
  // #1319 — read on the server (lib/data/org-receivables) and handed down, so
  // the ledger is never queried from the browser. Null when the server gate
  // said no, which is the same case in which nothing below renders anyway.
  receivables = null,
}: {
  orgId: string;
  receivables?: OrgReceivablesPayload | null;
}) {
  const { can } = useOrgRole(orgId);
  const { allowed } = useRequireOrgAccess(orgId, {
    permission: "billing.read",
    canSponsor: true,
  });

  const summary = useQuery({
    queryKey: ["org-billing", orgId],
    queryFn: () => fetchBilling(orgId),
    enabled: allowed,
  });
  // Shared org-details cache (the layout already fetched it).
  const orgDetails = useQuery({
    queryKey: orgDetailsQueryKey(orgId),
    queryFn: () => fetchOrgDetails(orgId),
    staleTime: 60_000,
  });
  const org = orgDetails.data?.organization;

  // #1427/#1430 — a frozen wallet or a dunning-suspended org blocks the same
  // pay/top-up affordances as an unverified org; the server rejects either way.
  const walletFrozen = summary.data?.walletFrozen ?? false;
  const dunningSuspended = summary.data?.dunningSuspended ?? false;
  const moneyMoveBlocked =
    org?.status === "PENDING_VERIFICATION" ||
    org?.status === "SUSPENDED" ||
    walletFrozen ||
    dunningSuspended;
  const moneyMoveReason = moneyBlockReason({
    walletFrozen,
    walletFrozenReason: summary.data?.walletFrozenReason,
    dunningSuspended,
    orgStatus: org?.status,
  });

  if (!allowed) return null;

  const fundingSource =
    summary.data?.fundingSource ?? org?.fundingSource ?? null;
  const orgName = org?.name ?? "our organization";
  // The org Support page is operations.read; finance-only roles lack it.
  const supportHref = can("operations.read")
    ? `/dashboard/organization/${orgId}/support`
    : "/dashboard/go/auto/support";

  return (
    <>
      <DashboardHeader
        title="Billing"
        description="Invoices, balances and everything this organization pays for."
        actions={
          <div className="flex flex-wrap gap-2">
            {/* Wave-4b (#1230) — register export for finance reconciliation. */}
            <Button asChild size="sm" variant="outline">
              <a
                href={`/api/organizations/${orgId}/billing-account/invoices/export`}
              >
                Export CSV
              </a>
            </Button>
            {can("billing.manage") && (
              <CreateTicketDialog
                defaults={{
                  issueType: "BILLING_QUESTION",
                  title: `Invoice request for ${orgName}`,
                  description:
                    "Please issue an invoice for: \n\nBilling period or bookings covered: \nPurchase order number (if any): ",
                }}
                trigger={
                  <Button size="sm">
                    <FileText className="mr-1.5 h-4 w-4" />
                    Request an invoice
                  </Button>
                }
              />
            )}
          </div>
        }
      />
      <DashboardContent>
        {/* #1427 — shown above every Money tab, not only Invoices. */}
        <BillingBlockBanner
          walletFrozen={walletFrozen}
          walletFrozenReason={summary.data?.walletFrozenReason}
          dunningSuspended={dunningSuspended}
          supportHref={supportHref}
        />
        {moneyMoveBlocked && !walletFrozen && !dunningSuspended && (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              {moneyMoveReason}. Paying invoices and wallet top-ups are disabled
              until then.
            </p>
          </div>
        )}

        <UrlTabs
          tabs={[
            {
              value: "invoices",
              label: "Invoices",
              content: (
                <InvoicesPanel
                  orgId={orgId}
                  summary={summary}
                  canPay={can("billing.manage")}
                  moneyMoveBlocked={moneyMoveBlocked}
                  moneyMoveReason={moneyMoveReason}
                />
              ),
            },
            {
              value: "accrued-usage",
              label: "Accrued usage",
              // A wallet shortfall also accrues, so real postings keep it.
              show:
                fundingSource === "INVOICE" ||
                (receivables?.totalPostings ?? 0) > 0,
              content: <AccruedUsagePanel receivables={receivables} />,
            },
            {
              value: "wallet",
              label: "Wallet",
              show: fundingSource === "WALLET",
              content: (
                <WalletTab
                  orgId={orgId}
                  moneyMoveBlocked={moneyMoveBlocked}
                  moneyMoveReason={moneyMoveReason}
                />
              ),
            },
            {
              value: "license",
              label: "License",
              show: fundingSource === "LICENSE",
              content: <LicensePanel summary={summary.data} />,
            },
            {
              value: "purchase-orders",
              label: "Purchase orders",
              show: (org?.requiresPO ?? false) && can("purchaseOrders.read"),
              content: <PurchaseOrdersPanel orgId={orgId} />,
            },
            {
              value: "disputes",
              label: "Disputes",
              show: can("disputes.read"),
              content: <DisputesPanel orgId={orgId} />,
            },
            {
              value: "member-spend",
              label: "Member spend",
              show: fundingSource === "PERSONAL" && can("reimbursements.read"),
              content: <MemberSpendPanel orgId={orgId} />,
            },
          ]}
        />

        <p className="text-sm text-muted-foreground">
          Questions about a charge or an invoice?{" "}
          <CreateTicketDialog
            defaults={{
              issueType: "BILLING_QUESTION",
              title: `Billing question from ${orgName}`,
            }}
            trigger={
              <button
                type="button"
                className="font-medium text-foreground underline underline-offset-2"
              >
                Ask us
              </button>
            }
          />
          .
        </p>
      </DashboardContent>
    </>
  );
}
