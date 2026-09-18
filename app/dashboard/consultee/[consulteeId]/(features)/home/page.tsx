import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import HomePageClient from "./HomePageClient";
import { readConsulteeEvents } from "@/lib/data/consultee-events-read";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import { getViewerZone } from "@/lib/time/viewer-zone-server";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default async function HomePage({ params }: Readonly<PageProps>) {
  const { consulteeId } = await params;
  // Ownership is enforced HERE, not by the layout: the layout is a client
  // component, so its check runs after this server render has already read
  // and streamed the data. See lib/auth/personal-dashboard-access.ts.
  await requirePersonalProfileAccess("consultee", consulteeId);
  // Read here and passed down exactly as the Appointments page does, so Home
  // and Appointments show one clock time for one session (#1703).
  const viewerZone = await getViewerZone();
  const queryClient = new QueryClient();

  // #890 — SSR prefetch. Home is personal-pinned (ADR 19, #1166 ORG-3), so
  // "personal" is the only scope the client ever asks for and hydration
  // always hits. Key base MUST match createConsulteeQueries(...).events:
  // ["consultee-events", id, scope]. allSettled so a read failure degrades
  // to a client-side fetch rather than crashing the route.
  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: ["consultee-events", consulteeId, "personal"],
      queryFn: () => readConsulteeEvents(consulteeId, { kind: "personal" }),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <HomePageClient consulteeId={consulteeId} viewerZone={viewerZone} />
    </HydrationBoundary>
  );
}
