"use client";

import { use } from "react";

import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { Section } from "@/components/dashboard/Section";
import { TabsWithOverflow } from "@/components/dashboard/shared/TabsWithOverflow";
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
 * Org Payouts: Runs & earnings · Payout account · Rate cards & routing —
 * everything a hosting org is paid through, on one page.
 */
export function PayoutsPageClient({
  params,
  livePayoutsEnabled,
}: {
  params: Promise<{ orgId: string }>;
  livePayoutsEnabled: boolean;
}) {
  const { orgId } = use(params);
  const { can } = useOrgRole(orgId);
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
        <TabsWithOverflow
          tabs={[
            {
              value: "runs",
              label: "Runs & earnings",
              content: (
                <>
                  <PayoutRunsPanel
                    orgId={orgId}
                    orgSlug={org.organization.slug}
                    canManage={can("payouts.manage")}
                    canApprove={can("payouts.approve")}
                    livePayoutsEnabled={livePayoutsEnabled}
                  />
                  <Section id="earnings" title="Earnings">
                    <OrgEarningsPanel orgId={orgId} anchorId="earnings" />
                  </Section>
                </>
              ),
            },
            {
              value: "payout-account",
              label: "Payout account",
              // PUT is payouts.account.manage (OWNER); everyone else reads.
              content: (
                <PayoutAccountPanel
                  orgId={orgId}
                  canEdit={can("payouts.account.manage")}
                />
              ),
            },
            {
              value: "rate-cards",
              label: "Rate cards & routing",
              content: (
                <>
                  <RateCardsPanel
                    orgId={orgId}
                    canManage={can("payouts.manage")}
                  />
                  {/* A Billing admin changes where experts are paid here,
                      without the member list it cannot read. */}
                  <Section id="expert-routing" title="Expert routing">
                    <ExpertPayoutRoutingPanel
                      orgId={orgId}
                      canManage={can("members.payoutRecipient.change")}
                      anchorId="expert-routing"
                    />
                  </Section>
                </>
              ),
            },
          ]}
        />
      </DashboardContent>
    </>
  );
}
