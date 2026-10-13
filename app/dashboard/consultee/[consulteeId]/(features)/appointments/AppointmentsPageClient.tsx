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
import { WaitlistOfferBanner } from "./WaitlistOfferBanner";

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

  const vms = useMemo(() => mapConsulteeEvents(eventsData), [eventsData]);

  return (
    <DashboardErrorBoundary>
      <PageHeader
        title="Appointments"
        description="Your consultations, subscriptions, webinars, and classes"
      />
      <WaitlistOfferBanner viewerZone={viewerZone} />
      <div>
        {isLoading && !eventsData ? (
          <AppointmentsPageSkeleton />
        ) : error ? (
          <ErrorState
            title="Couldn't load appointments"
            error={error}
            onRetry={() => void refetch()}
          />
        ) : (
          <DisplayZoneProvider zone={viewerZone.zone}>
            <AppointmentsShell
              vms={vms}
              adapter={adapter}
              viewerZone={viewerZone}
            />
          </DisplayZoneProvider>
        )}
      </div>
    </DashboardErrorBoundary>
  );
}
