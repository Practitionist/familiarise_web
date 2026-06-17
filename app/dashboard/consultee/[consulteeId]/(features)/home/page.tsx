import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import HomePageClient from "./HomePageClient";
import {
  prefetchConsulteeEvents,
  DEFAULT_CONSULTEE_EVENTS_SCOPE_KEY,
} from "@/lib/server/consultee-prefetch";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default async function HomePage({ params }: Readonly<PageProps>) {
  const { consulteeId } = await params;
  const queryClient = new QueryClient();

  // #890 — SSR prefetch the default (personal) scope so the client
  // useQuery hydrates without a fetch waterfall. Key base MUST match
  // createConsulteeQueries(...).events: ["consultee-events", id, scope].
  // allSettled so a read failure degrades to a client-side fetch rather
  // than crashing the route.
  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: [
        "consultee-events",
        consulteeId,
        DEFAULT_CONSULTEE_EVENTS_SCOPE_KEY,
      ],
      queryFn: () => prefetchConsulteeEvents(consulteeId),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <HomePageClient consulteeId={consulteeId} />
    </HydrationBoundary>
  );
}
