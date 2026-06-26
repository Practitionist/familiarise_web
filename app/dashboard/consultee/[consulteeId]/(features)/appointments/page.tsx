import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import AppointmentsPageClient from "./AppointmentsPageClient";
import { readConsulteeEvents } from "@/lib/data/consultee-events-read";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default async function AppointmentsPage({
  params,
}: Readonly<PageProps>) {
  const { consulteeId } = await params;
  const queryClient = new QueryClient();

  // #890 — SSR prefetch the default (personal) scope so the client
  // useQuery hydrates without a fetch waterfall. Key base MUST match
  // createConsulteeQueries(...).events: ["consultee-events", id, scope].
  // The route's default (no ?orgScope=) is `personal`, so the scope
  // segment is the literal "personal" and the read runs with that scope.
  // Org members default to the "all" scope (role-dependent, client-only),
  // so they fall back to a client fetch — only B2C/personal users hydrate.
  // allSettled so a read failure degrades to a client-side fetch rather
  // than crashing the route.
  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: ["consultee-events", consulteeId, "personal"],
      queryFn: () => readConsulteeEvents(consulteeId, { kind: "personal" }),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <AppointmentsPageClient consulteeId={consulteeId} />
    </HydrationBoundary>
  );
}
