import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";

import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { buildConsultantEarningsPagePayloads } from "@/lib/data/consultant-earnings-analytics";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import { ENABLE_LIVE_PAYOUTS } from "@/lib/feature-flags";
import { readConsultantPayoutSetup } from "@/lib/data/consultant-payout-setup";

import { EARNINGS_FETCH_CAP } from "@/lib/dashboard/earnings-state";

import { payoutSetupQueryKey } from "../settings/get-paid/payout-setup-keys";
import { EarningsTabs } from "./EarningsTabs";
import { PayoutStatusChip } from "./PayoutStatusChip";

type PageProps = {
  params: Promise<{ consultantId: string }>;
};

/**
 * /dashboard/consultant/[consultantId]/earnings — Summary · Activity · Analytics.
 *
 * This route was a client component until Analytics folded into it (ADR 19).
 * It is a server component now so the Analytics panel keeps the SSR prefetch it
 * had as its own page; since PR-Y (#1675) the Summary panel is seeded the same
 * way, so the tiles paint on first render.
 */
export default async function EarningsPage({ params }: Readonly<PageProps>) {
  const { consultantId } = await params;
  // Ownership is enforced HERE, not by the layout: the layout is a client
  // component, so its check runs after this server render has already read
  // and streamed the data. See lib/auth/personal-dashboard-access.ts.
  await requirePersonalProfileAccess("consultant", consultantId);
  const queryClient = new QueryClient();

  // Keys MUST match the panels' useQuery keys exactly or hydration won't
  // apply. Both earnings seeds come from one pass over the reads they share.
  // A failed read degrades to a client-side fetch rather than crashing the page.
  const earnings = await buildConsultantEarningsPagePayloads(consultantId, {
    limit: EARNINGS_FETCH_CAP,
  }).catch(() => null);
  if (earnings) {
    // Mirrors EarningsSummaryPanel's fetch: the same cap, personal scope, and
    // the server-only flag the client cannot read.
    queryClient.setQueryData(["consultant-earnings", consultantId], {
      ...earnings.summary,
      livePayoutsEnabled: ENABLE_LIVE_PAYOUTS,
    });
    queryClient.setQueryData(
      ["consultant-earnings-analytics", consultantId],
      earnings.analytics,
    );
  }
  // #1527 — the header's payout-status chip reads the Get-paid seed. The
  // Analytics tab fetches its session list itself when opened.
  await queryClient
    .prefetchQuery({
      queryKey: payoutSetupQueryKey(consultantId),
      queryFn: () => readConsultantPayoutSetup(consultantId),
    })
    .catch(() => undefined);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <DashboardHeader
        title="Earnings & payouts"
        subtitle="When you get paid, and what each offering earns"
        actions={<PayoutStatusChip consultantId={consultantId} />}
      />
      <EarningsTabs consultantId={consultantId} />
    </HydrationBoundary>
  );
}
