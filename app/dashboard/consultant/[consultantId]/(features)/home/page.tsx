import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import HomePageClient from "./HomePageClient";
import { getConsultantDashboard } from "@/lib/data/consultant-dashboard";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";

type PageProps = {
  params: Promise<{ consultantId: string }>;
};

export default async function HomePage({ params }: Readonly<PageProps>) {
  const { consultantId } = await params;
  // Ownership is enforced HERE, not by the layout: the layout is a client
  // component, so its check runs after this server render has already read
  // and streamed the data. See lib/auth/personal-dashboard-access.ts.
  await requirePersonalProfileAccess("consultant", consultantId);
  const queryClient = new QueryClient();

  // #890 — SSR prefetch the dashboard so the client useQuery hydrates
  // without a fetch waterfall. Key MUST match
  // createConsultantQueries(...).dashboard: ["consultant-dashboard", id].
  // The Home query is NOT org-scoped (route filters by consultantProfileId
  // only), so there is a single deterministic payload to prefetch.
  // allSettled so a read failure degrades to a client-side fetch rather
  // than crashing the route.
  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: ["consultant-dashboard", consultantId],
      queryFn: () => getConsultantDashboard(consultantId),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <HomePageClient consultantId={consultantId} />
    </HydrationBoundary>
  );
}
