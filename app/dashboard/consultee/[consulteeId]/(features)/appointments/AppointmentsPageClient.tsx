"use client";

import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CalendarX } from "lucide-react";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { EmptyState } from "@/components/dashboard/DataCard";
import { Button } from "@/components/ui/button";
import { AppointmentsShell } from "@/components/appointments/AppointmentsShell";
import { AppointmentsPageSkeleton } from "@/components/appointments/skeletons";
import { mapConsulteeEvents } from "@/lib/appointments/map-consultee";
import { createConsulteeQueries } from "@/lib/dashboard-queries";
import { useOrgScope } from "@/hooks/useOrgScope";
import {
  OrgContextFilter,
  ORG_FILTER_ALL,
  ORG_FILTER_PERSONAL,
  type OrgContextFilterValue,
} from "@/components/dashboard/OrgContextFilter";
import { useConsulteeAppointmentsAdapter } from "./ConsulteeAppointmentsAdapter";

export default function AppointmentsPageClient({
  consulteeId,
}: Readonly<{ consulteeId: string }>) {
  // B1-personal-retrofit: drive the events query off the URL ?orgScope=
  // so org-funded sessions surface here. Org members land on the union
  // view by default; B2C users stay personal (#890).
  const { scope, setScope } = useOrgScope({ defaultForOrgMember: "all" });
  const orgScopeParam =
    scope.kind === "personal"
      ? "personal"
      : scope.kind === "all"
        ? "all"
        : scope.orgId;
  const eventsQuery = createConsulteeQueries(consulteeId, orgScopeParam).events;
  // keepPreviousData: scope-filter changes show the previous list while the
  // new one loads instead of a skeleton flash (documents-page idiom, #346).
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

  const filterValue: OrgContextFilterValue =
    scope.kind === "personal"
      ? ORG_FILTER_PERSONAL
      : scope.kind === "all"
        ? ORG_FILTER_ALL
        : scope.orgId;
  const handleFilterChange = (next: OrgContextFilterValue) => {
    if (next === ORG_FILTER_PERSONAL) setScope({ kind: "personal" });
    else if (next === ORG_FILTER_ALL) setScope({ kind: "all" });
    else setScope({ kind: "org", orgId: next });
  };

  return (
    <DashboardErrorBoundary>
      <DashboardHeader
        title="Appointments"
        subtitle="Your consultations, subscriptions, webinars, and classes"
      />
      <div className="pt-6">
        {isLoading && !eventsData ? (
          <AppointmentsPageSkeleton />
        ) : error ? (
          <EmptyState
            icon={CalendarX}
            title="Couldn't load appointments"
            description={
              error instanceof Error
                ? error.message
                : "Failed to load appointments. Please try again."
            }
            action={
              <Button variant="outline" onClick={() => void refetch()}>
                Retry
              </Button>
            }
          />
        ) : (
          <AppointmentsShell
            vms={vms}
            adapter={adapter}
            orgFilterSlot={
              <OrgContextFilter
                value={filterValue}
                onChange={handleFilterChange}
              />
            }
          />
        )}
      </div>
    </DashboardErrorBoundary>
  );
}
