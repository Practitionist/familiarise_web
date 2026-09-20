import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";

import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { getConsultantAppointments } from "@/lib/data/consultant-appointments";
import { buildConsultantEarningsPayload } from "@/lib/data/consultant-earnings-analytics";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import { ENABLE_LIVE_PAYOUTS } from "@/lib/feature-flags";

import { EARNINGS_FETCH_CAP } from "@/lib/dashboard/earnings-state";

import { EarningsTabs } from "./EarningsTabs";

type PageProps = {
  params: Promise<{ consultantId: string }>;
};

/**
 * /dashboard/consultant/[consultantId]/earnings — Summary + Analytics.
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

  // Keys MUST match AnalyticsPageClient's useQuery keys exactly or hydration
  // won't apply. allSettled so a failed read degrades to a client-side fetch
  // rather than crashing the whole page.
  await Promise.allSettled([
    queryClient.prefetchQuery({
      // Mirrors EarningsSummaryPanel's fetch: the same cap, personal scope,
      // and the server-only flag the client cannot read.
      queryKey: ["consultant-earnings", consultantId],
      queryFn: async () => ({
        ...(await buildConsultantEarningsPayload(consultantId, {
          limit: EARNINGS_FETCH_CAP,
          organizationId: null,
        })),
        livePayoutsEnabled: ENABLE_LIVE_PAYOUTS,
      }),
    }),
    queryClient.prefetchQuery({
      queryKey: ["consultant-earnings-analytics", consultantId],
      queryFn: () =>
        // #org-appts (#1024) — personal dashboard = B2C-only VIEW.
        // Explicit to match the client's default (unset orgScope).
        buildConsultantEarningsPayload(consultantId, {
          limit: 1,
          includeMonthly: true,
          organizationId: null,
        }),
    }),
    queryClient.prefetchQuery({
      queryKey: ["consultant-appointments", consultantId, "personal"],
      queryFn: () =>
        getConsultantAppointments({
          consultantProfileId: consultantId,
          scope: { kind: "personal" },
        }),
    }),
  ]);

  return (
    <>
      <DashboardHeader
        title="Earnings"
        subtitle="Income and performance across your practice"
      />
      <HydrationBoundary state={dehydrate(queryClient)}>
        <EarningsTabs consultantId={consultantId} />
      </HydrationBoundary>
    </>
  );
}
