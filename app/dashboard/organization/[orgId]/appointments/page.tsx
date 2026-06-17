import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import { AppointmentsPageClient } from "./AppointmentsPageClient";
import { getOrgAppointments } from "@/lib/data/org-appointments";

// #890 — prefetch only the default page (page 1, no filters). Pagination
// and filters fall back to the client fetch (queryKey diverges by page,
// so a non-default page simply misses the hydrated cache).
export default async function OrgAppointmentsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const queryClient = new QueryClient();

  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: ["org-appointments", orgId, 1],
      queryFn: () => getOrgAppointments(orgId, { page: 1 }),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <AppointmentsPageClient orgId={orgId} />
    </HydrationBoundary>
  );
}
