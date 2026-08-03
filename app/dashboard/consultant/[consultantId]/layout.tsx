import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import ConsultantDashboardShell from "./ConsultantDashboardShell";
import { getUserDetails } from "@/lib/data/user-details";
import { toPlain } from "@/lib/data/serialize";
import { getSession } from "@/lib/auth-server";

/**
 * Server shell whose only job is to hydrate the layout's own query.
 *
 * `ConsultantDashboardShell` is a client component that returns
 * `PersonalDashboardShellSkeleton` instead of `children` whenever its queries
 * are loading — which is ALWAYS true during SSR, because nothing prefetched
 * them. The result: no dashboard markup reached the HTML at all. Measured on
 * #1103, the server response contained no `<h1`, none of the sidebar nav, and
 * FCP sat at ~6s while "Welcome back" arrived at 4.6s inside the RSC payload.
 *
 * That guard is `(...loading) && !consultantData && !userDetails`, so seeding
 * EITHER query opens it. This seeds `user-details` rather than
 * `consultant-data` on purpose: the consultant read carries public/private
 * access levels, #726 plan-visibility filtering and PII narrowing, and
 * re-deriving that for a prefetch is exactly how the #946 leak happened. This
 * one is the viewer's own row, so authorization here is just "the session
 * user's own id" — never the `consultantId` from the URL, which may belong to
 * someone else when an ADMIN/STAFF is inspecting.
 *
 * The query key MUST stay in step with the shell's `useQuery`:
 * `["user-details", userId]`.
 */
export default async function ConsultantDashboardLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ consultantId: string }>;
}>) {
  const session = await getSession(true);
  const queryClient = new QueryClient();

  const userId = session?.user?.id;
  if (userId) {
    // Swallow: a failed seed should fall back to the client fetch, not 500 the
    // whole dashboard. Losing the seed only costs the SSR shell.
    await queryClient
      .prefetchQuery({
        queryKey: ["user-details", userId],
        // The route responds `{ data: user }` and the client fetcher unwraps
        // `.data`, so the cached value is the user row itself.
        queryFn: async () => toPlain(await getUserDetails(userId)),
      })
      .catch(() => undefined);
  }

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <ConsultantDashboardShell params={params}>
        {children}
      </ConsultantDashboardShell>
    </HydrationBoundary>
  );
}
