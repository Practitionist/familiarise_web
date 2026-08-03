import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import HomePageClient from "./HomePageClient";
import { readConsulteeEvents } from "@/lib/data/consultee-events-read";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import { getSession } from "@/lib/auth-server";
import {
  resolveDefaultScopeKey,
  scopeFromKey,
} from "@/lib/api/scope/server-default";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default async function HomePage({
  params,
  searchParams,
}: Readonly<PageProps>) {
  const { consulteeId } = await params;
  const orgScope = (await searchParams)?.orgScope;
  // Ownership is enforced HERE, not by the layout: the layout is a client
  // component, so its check runs after this server render has already read
  // and streamed the data. See lib/auth/personal-dashboard-access.ts.
  await requirePersonalProfileAccess("consultee", consulteeId);
  // Shares React.cache with the access guard / dashboard layout.
  const session = await getSession();
  // Shared with useOrgScope's default rule so the two cannot drift, and it
  // honours ?orgScope= — which the local mirror did not, so every scope toggle
  // prefetched the wrong scope and threw the result away.
  const scopeKey = resolveDefaultScopeKey(session, {
    defaultForOrgMember: "all",
    orgScopeParam: typeof orgScope === "string" ? orgScope : null,
  });
  const scope = scopeFromKey(scopeKey);
  const queryClient = new QueryClient();

  // #890 — SSR prefetch the same default scope the client useQuery asks for
  // so hydration hits. Key base MUST match
  // createConsulteeQueries(...).events: ["consultee-events", id, scope].
  // allSettled so a read failure degrades to a client-side fetch rather
  // than crashing the route.
  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: ["consultee-events", consulteeId, scopeKey],
      queryFn: () => readConsulteeEvents(consulteeId, scope),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <HomePageClient consulteeId={consulteeId} />
    </HydrationBoundary>
  );
}
