import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import HomePageClient from "./HomePageClient";
import { NeedsYouCard } from "@/components/dashboard/NeedsYouCard";
import { getConsultantDashboard } from "@/lib/data/consultant-dashboard";
import { getNeedsYouSummary, type NeedsYouSummary } from "@/lib/data/needs-you";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";

type PageProps = {
  params: Promise<{ consultantId: string }>;
};

export default async function HomePage({ params }: Readonly<PageProps>) {
  const { consultantId } = await params;
  // Ownership is enforced HERE, not by the layout: the layout is a client
  // component, so its check runs after this server render has already read
  // and streamed the data. See lib/auth/personal-dashboard-access.ts.
  const access = await requirePersonalProfileAccess("consultant", consultantId);
  const queryClient = new QueryClient();

  // Cross-context roll-up (ADR 19's sanctioned "derived read"). Skipped when an
  // ADMIN/STAFF is inspecting someone else's dashboard: the summary keys off
  // the VIEWER's memberships, which are not the profile owner's, so it would
  // answer a question nobody asked. Failure is non-fatal — the card is
  // supplementary and the page must not 500 because a count timed out.
  let needsYou: NeedsYouSummary | null = null;
  if (!access.isInspecting) {
    needsYou = await getNeedsYouSummary(access.userId, consultantId).catch(
      () => null,
    );
  }

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
      {needsYou && (
        <div className="px-4 pt-4 sm:px-6 lg:px-8">
          <NeedsYouCard summary={needsYou} />
        </div>
      )}
      <HomePageClient consultantId={consultantId} />
    </HydrationBoundary>
  );
}
