"use client";

import { useQuery } from "@tanstack/react-query";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { HomeSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { createConsulteeQueries } from "@/lib/dashboard-queries";
import HomeTab from "./HomeTab";
import type { ViewerZone } from "@/lib/time/viewer-zone";
import { useUser } from "../../UserContext";

export default function HomePageClient({
  consulteeId,
  viewerZone,
}: Readonly<{ consulteeId: string; viewerZone: ViewerZone }>) {
  const { userDetails } = useUser();

  // Personal pin, matching the sibling Appointments page (ADR 19). The old
  // defaultForOrgMember: "all" here papered over the missing attendee arm in
  // the orgMember scope (#1166 ORG-5); org-funded sessions now live on the
  // org dashboard, which can actually show them.
  //
  // `eventsHome` is the factory's Home-tuned twin of `events` (same key base
  // as the SSR seed, calmer refresh posture) — keep query config in the
  // factory so both tabs stay consistent by construction.
  const eventsQuery = createConsulteeQueries(consulteeId).eventsHome;
  const { data: eventsData, isLoading, error, refetch } = useQuery(eventsQuery);

  // Show skeleton only for initial load when no data exists
  if (isLoading && !eventsData) {
    return <HomeSkeleton />;
  }

  if (error && !eventsData) {
    return (
      <ErrorState
        title="Couldn't load your sessions"
        error={error}
        onRetry={() => void refetch()}
      />
    );
  }

  if (!eventsData) {
    return <HomeSkeleton />;
  }

  return (
    <DashboardErrorBoundary>
      <HomeTab
        eventsData={eventsData}
        viewerZone={viewerZone}
        // Nullable by design: events paint first, the greeting fills in when
        // the layout user fetch lands (was: full-page skeleton until both).
        userDetails={
          userDetails
            ? {
                id: userDetails.id,
                name: userDetails.name ?? "User",
                email: userDetails.email ?? "",
                image: userDetails.image ?? undefined,
              }
            : null
        }
        consulteeId={consulteeId}
      />
    </DashboardErrorBoundary>
  );
}
