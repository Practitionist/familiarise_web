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
import { caseKeyOf } from "@/lib/support/case-key";
import { BillingBlockBanner } from "@/components/billing/BillingBlockBanner";
import {
  MotivationBanner,
  resolveFundingRailMotivation,
} from "@/components/organization/MotivationBanner";
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

function resolveWalletTopUpBlockReason(opts: {
  walletFrozen: boolean;
  walletFrozenReason: string | null | undefined;
  orgStatus: string | undefined;
}): string {
  if (opts.walletFrozen) {
    return opts.walletFrozenReason ?? "Wallet spend is frozen";
  }
  if (opts.orgStatus === "SUSPENDED") return "Organization suspended";
  return "Verify your organization to move money";
}

function resolveInvoicePaymentBlockReason(
  orgStatus: string | undefined,
): string {
  if (orgStatus === "SUSPENDED") return "Organization suspended";
  return "Verify your organization to move money";
}

/**
 * Org Billing: every money tab the org's funding shape uses on a single page.
 * Each tab shows when the funding source, flags, and viewer permissions make
 * it meaningful. Orgs request invoices from the platform via support tickets.
 */
export function BillingPageClient({
  orgId,
  receivables = null,
}: {
  orgId: string;
  receivables?: OrgReceivablesPayload | null;
}) {
  const { can } = useOrgRole(orgId);
  const requestHref = (ticketId: string) =>
    `/dashboard/organization/${orgId}/support/requests/${caseKeyOf({ kind: "ticket", id: ticketId })}`;
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

  // Wallet top-ups and invoice payments have distinct block conditions:
  // a dunning-suspended or wallet-frozen org must remain able to pay its
  // overdue/issued invoices so it can settle its balance and lift dunning.
  const walletFrozen = summary.data?.walletFrozen ?? false;
  const dunningSuspended = summary.data?.dunningSuspended ?? false;
  const walletTopUpBlocked =
    org?.status === "PENDING_VERIFICATION" ||
    org?.status === "SUSPENDED" ||
    walletFrozen;
  const walletTopUpReason = resolveWalletTopUpBlockReason({
    walletFrozen,
    walletFrozenReason: summary.data?.walletFrozenReason,
    orgStatus: org?.status,
  });
  const invoicePaymentBlocked =
    org?.status === "PENDING_VERIFICATION" || org?.status === "SUSPENDED";
  const invoicePaymentReason = resolveInvoicePaymentBlockReason(org?.status);

  if (!allowed) return null;

  const fundingSource =
    summary.data?.fundingSource ?? org?.fundingSource ?? null;
  const fundingMotivation = fundingSource
    ? resolveFundingRailMotivation(fundingSource)
    : null;
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
            <Button asChild size="sm" variant="outline">
              <a
                href={`/api/organizations/${orgId}/billing-account/invoices/export`}
              >
                Export CSV
              </a>
            </Button>
            {can("billing.manage") && (
              <CreateTicketDialog
                requestHref={requestHref}
                defaults={{
                  issueType: "BILLING_QUESTION",
                  organizationId: orgId,
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
        <BillingBlockBanner
          walletFrozen={walletFrozen}
          walletFrozenReason={summary.data?.walletFrozenReason}
          dunningSuspended={dunningSuspended}
          supportHref={supportHref}
        />
        {invoicePaymentBlocked && (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              {invoicePaymentReason}. Paying invoices and wallet top-ups are
              disabled until then.
            </p>
          </div>
        )}
        {fundingMotivation && (
          <MotivationBanner
            tier={fundingMotivation.tier}
            title={fundingMotivation.title}
            message={fundingMotivation.message}
            recommendation={fundingMotivation.recommendation}
            compact
          />
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
                  orgStatus={org?.status}
                  moneyMoveBlocked={invoicePaymentBlocked}
                  moneyMoveReason={invoicePaymentReason}
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
                  moneyMoveBlocked={walletTopUpBlocked}
                  moneyMoveReason={walletTopUpReason}
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
            requestHref={requestHref}
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
