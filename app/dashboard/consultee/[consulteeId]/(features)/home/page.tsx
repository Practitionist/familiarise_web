import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import HomePageClient from "./HomePageClient";
import { readConsulteeEvents } from "@/lib/data/consultee-events-read";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import { getSession } from "@/lib/auth-server";
import type { Scope } from "@/lib/api/scope/parse";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

/**
 * Mirror useOrgScope({ defaultForOrgMember: "all" }) when the URL has no
 * ?orgScope= — otherwise SSR dehydrates "personal" and org members immediately
 * refetch "all".
 */
function defaultHomeScope(session: Awaited<ReturnType<typeof getSession>>): Scope {
  const role = session?.user?.role;
  const firstOrgId =
    session?.user?.organizationMemberships?.[0]?.organizationId ?? null;
  if (role === "ADMIN" || role === "STAFF" || firstOrgId) {
    return { kind: "all" };
  }
  return { kind: "personal" };
}

function scopeQueryKey(scope: Scope): string {
  if (scope.kind === "personal") return "personal";
  if (scope.kind === "all") return "all";
  return scope.orgId;
}

export default async function HomePage({ params }: Readonly<PageProps>) {
  const { consulteeId } = await params;
  // Ownership is enforced HERE, not by the layout: the layout is a client
  // component, so its check runs after this server render has already read
  // and streamed the data. See lib/auth/personal-dashboard-access.ts.
  await requirePersonalProfileAccess("consultee", consulteeId);
  // Shares React.cache with the access guard / dashboard layout.
  const session = await getSession();
  const scope = defaultHomeScope(session);
  const scopeKey = scopeQueryKey(scope);
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
