import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import AnalyticsPageClient from "./AnalyticsPageClient";
import { getConsultantAppointments } from "@/lib/data/consultant-appointments";
import { buildConsultantEarningsPayload } from "@/lib/data/consultant-earnings-analytics";

type PageProps = {
  params: Promise<{ consultantId: string }>;
};

export default async function AnalyticsPage({ params }: Readonly<PageProps>) {
  const { consultantId } = await params;
  const queryClient = new QueryClient();

  // SSR prefetch both analytics reads (org home-page pattern). Keys MUST
  // match AnalyticsPageClient's useQuery keys exactly or hydration won't
  // apply. Payload parity is guaranteed structurally: the earnings payload
  // comes from the same buildConsultantEarningsPayload assembler the API
  // route serves, and the appointments read reuses the #890 prefetch
  // (personal scope — deterministic, session-independent). allSettled so a
  // failed read degrades to a client-side fetch rather than crashing.
  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: ["consultant-earnings-analytics", consultantId],
      queryFn: () =>
        buildConsultantEarningsPayload(consultantId, {
          limit: 1,
          includeMonthly: true,
        }),
    }),
    queryClient.prefetchQuery({
      queryKey: ["consultant-appointments", consultantId, "personal"],
      queryFn: () =>
        getConsultantAppointments({
          consultantProfileId: consultantId,
          orgScopeFilter: { organizationId: null },
        }),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <AnalyticsPageClient consultantId={consultantId} />
    </HydrationBoundary>
  );
}
