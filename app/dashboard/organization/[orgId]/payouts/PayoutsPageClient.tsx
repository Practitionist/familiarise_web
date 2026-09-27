"use client";

import { use } from "react";

import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { UrlTabs } from "@/components/dashboard/UrlTabs";
import { useOrgRole, useRequireOrgAccess } from "../useOrgRole";
import { useQuery } from "@tanstack/react-query";
import {
  fetchOrgDetails,
  orgDetailsQueryKey,
} from "@/lib/api/organizations/org-details";

import { PayoutRunsPanel } from "./PayoutRunsPanel";
import { OrgEarningsPanel } from "./OrgEarningsPanel";
import { PayoutAccountPanel } from "./PayoutAccountPanel";
import { RateCardsPanel } from "./RateCardsPanel";
import { ExpertPayoutRoutingPanel } from "./ExpertPayoutRoutingPanel";

/**
 * Org Payouts (#1527 Q6/Q7): Runs · Earnings · Payout account · Rate cards ·
 * Expert routing — everything a hosting org is paid through, one page.
 */
export function PayoutsPageClient({
  params,
  livePayoutsEnabled,
}: {
  params: Promise<{ orgId: string }>;
  livePayoutsEnabled: boolean;
}) {
  const { orgId } = use(params);
  const { can, role } = useOrgRole(orgId);
  const { allowed } = useRequireOrgAccess(orgId, {
    permission: "payouts.read",
    canHost: true,
  });
  const { data: org } = useQuery({
    queryKey: orgDetailsQueryKey(orgId),
    queryFn: () => fetchOrgDetails(orgId),
    staleTime: 60_000,
  });

  if (!allowed || !org) return null;

  return (
    <>
      <DashboardHeader
        title="Payouts"
        description="What this organization earns from its offerings, and where it is paid."
      />
      <DashboardContent>
        <UrlTabs
          tabs={[
            {
              value: "runs",
              label: "Runs",
              content: (
                <PayoutRunsPanel
                  orgId={orgId}
                  orgSlug={org.organization.slug}
                  canManage={can("payouts.manage")}
                  livePayoutsEnabled={livePayoutsEnabled}
                />
              ),
            },
            {
              value: "earnings",
              label: "Earnings",
              content: <OrgEarningsPanel orgId={orgId} />,
            },
            {
              value: "payout-account",
              label: "Payout account",
              // PUT is requireOrgOwner; everyone else reads.
              content: (
                <PayoutAccountPanel orgId={orgId} canEdit={role === "OWNER"} />
              ),
            },
            {
              value: "rate-cards",
              label: "Rate cards",
              content: (
                <RateCardsPanel
                  orgId={orgId}
                  canManage={can("payouts.manage")}
                />
              ),
            },
            {
              value: "expert-routing",
              label: "Expert routing",
              // #1846 — a Billing admin changes where experts are paid here,
              // without the member list it cannot read.
              content: (
                <ExpertPayoutRoutingPanel
                  orgId={orgId}
                  canManage={can("payouts.manage")}
                />
              ),
            },
          ]}
        />
      </DashboardContent>
    </>
  );
}
