"use client";

import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { AppointmentsShell } from "@/components/appointments/AppointmentsShell";
import type { ViewerZone } from "@/lib/time/viewer-zone";
import { DisplayZoneProvider } from "@/lib/time/zoned-format";
import { AppointmentsPageSkeleton } from "@/components/appointments/skeletons";
import { mapConsulteeEvents } from "@/lib/appointments/map-consultee";
import { createConsulteeQueries } from "@/lib/dashboard-queries";
import { useConsulteeAppointmentsAdapter } from "@/components/appointments/consultee/ConsulteeAppointmentsAdapter";
import { IncidentRemedyBanner } from "@/components/appointments/consultee/IncidentRemedyBanner";
import { MyAlerts } from "@/components/appointments/consultee/MyAlerts";
import { useUser } from "../../UserContext";

export default function AppointmentsPageClient({
  consulteeId,
  viewerZone,
}: Readonly<{ consulteeId: string; viewerZone: ViewerZone }>) {
  const eventsQuery = createConsulteeQueries(consulteeId).events;
  const {
    data: eventsData,
    isLoading,
    error,
    refetch,
  } = useQuery({
    ...eventsQuery,
    placeholderData: keepPreviousData,
  });

  const adapter = useConsulteeAppointmentsAdapter();

  const zone = viewerZone.zone;
  // The route's learner decides which reschedule proposals are theirs, whoever is viewing.
  const { userDetails, learner } = useUser();
  const learnerUserId = learner?.userId ?? null;
  const isOwner = userDetails?.consulteeProfileId === consulteeId;
  const vms = useMemo(
    () => mapConsulteeEvents(eventsData, new Date(), zone, learnerUserId),
    [eventsData, zone, learnerUserId],
  );
  // The alerts read the signed-in viewer's own waitlists.
  const alerts = isOwner ? <MyAlerts viewerZone={viewerZone} /> : null;

  return (
    <DashboardErrorBoundary>
      <PageHeader
        title="Appointments"
        description="Your consultations, subscriptions, webinars, and classes"
      />
      <IncidentRemedyBanner consulteeId={consulteeId} zone={viewerZone.zone} />
      <div>
        {isLoading && !eventsData ? (
          <AppointmentsPageSkeleton />
        ) : error ? (
          <>
            {/* The alerts read their own endpoints, so they stay usable. */}
            {alerts}
            <ErrorState
              title="Couldn't load appointments"
              error={error}
              onRetry={() => void refetch()}
            />
          </>
        ) : (
          <DisplayZoneProvider zone={viewerZone.zone}>
            <AppointmentsShell
              vms={vms}
              adapter={adapter}
              viewerZone={viewerZone}
              afterHero={alerts}
            />
          </DisplayZoneProvider>
        )}
      </div>
    </DashboardErrorBoundary>
  );
}
