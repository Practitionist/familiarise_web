import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import AnalyticsPageClient from "./AnalyticsPageClient";
import { getConsultantAppointments } from "@/lib/data/consultant-appointments";
import { buildConsultantEarningsPayload } from "@/lib/data/consultant-earnings-analytics";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";

type PageProps = {
  params: Promise<{ consultantId: string }>;
};

export default async function AnalyticsPage({ params }: Readonly<PageProps>) {
  const { consultantId } = await params;
  // Ownership is enforced HERE, not by the layout: the layout is a client
  // component, so its check runs after this server render has already read
  // and streamed the data. See lib/auth/personal-dashboard-access.ts.
  await requirePersonalProfileAccess("consultant", consultantId);
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
