import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import AppointmentsPageClient from "./AppointmentsPageClient";
import { getStaffAppointments } from "@/lib/data/staff-appointments";

export default async function StaffAppointmentsPage() {
  const queryClient = new QueryClient();

  // #890 — SSR prefetch the DEFAULT view (page 1, no filters) so the client
  // useQuery hydrates without a fetch waterfall. The queryKey object MUST match
  // the client's default in AppointmentsPageClient: ["staff-appointments",
  // { page: 1, type: "all", status: "all", search: "" }]. Filtered/paged views
  // fall back to a client fetch (acceptable). allSettled so a read failure
  // degrades to a client-side fetch rather than crashing the route.
  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: [
        "staff-appointments",
        { page: 1, type: "all", status: "all", search: "" },
      ],
      queryFn: () => getStaffAppointments({ page: 1 }),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <AppointmentsPageClient />
    </HydrationBoundary>
  );
}
