import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import AppointmentsPageClient from "./AppointmentsPageClient";
import {
  getConsultantAppointments,
  withPublicRequesterForStaff,
} from "@/lib/data/consultant-appointments";
import { getSession } from "@/lib/auth-server";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import { getViewerZone } from "@/lib/time/viewer-zone-server";

type PageProps = {
  params: Promise<{ consultantId: string }>;
};

export default async function AppointmentsPage({
  params,
}: Readonly<PageProps>) {
  const { consultantId } = await params;
  // Ownership is enforced HERE, not by the layout: the layout is a client
  // component, so its check runs after this server render has already read
  // and streamed the data. See lib/auth/personal-dashboard-access.ts.
  const access = await requirePersonalProfileAccess("consultant", consultantId);
  const viewer = access.isInspecting ? (await getSession())?.user : undefined;
  // Read here and passed down: the server render and the hydrating client
  // then format every time from the same zone (hydration #418).
  const viewerZone = await getViewerZone();
  const queryClient = new QueryClient();

  // #890 — SSR prefetch the DEFAULT ("personal") appointments view so the
  // client useQuery hydrates without a fetch waterfall. Key MUST match
  // createConsultantQueries(id, "personal").appointments:
  //   ["consultant-appointments", id, "personal"].
  // The scopeKey is part of the key, and the page's *resolved* default is
  // role/session-dependent (org members + admins default to "all" via
  // useOrgScope({ defaultForOrgMember: "all" }), B2C users to "personal").
  // We prefetch only "personal" — the deterministic, session-independent
  // default. Org/all-scope landings correctly fall
  // back to a client fetch (acceptable per #890). The scope handed down is the
  // same `Scope` the route's resolveOrgScope produces, so both paths project
  // it identically (#674 defect 13).
  // allSettled so a read failure degrades to a client-side fetch rather
  // than crashing the route.
  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: ["consultant-appointments", consultantId, "personal"],
      queryFn: async () => {
        const rows = await getConsultantAppointments({
          consultantProfileId: consultantId,
          scope: { kind: "personal" },
        });
        return viewer
          ? rows.map((row) => withPublicRequesterForStaff(row, viewer))
          : rows;
      },
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <AppointmentsPageClient
        consultantId={consultantId}
        viewerZone={viewerZone}
      />
    </HydrationBoundary>
  );
}
