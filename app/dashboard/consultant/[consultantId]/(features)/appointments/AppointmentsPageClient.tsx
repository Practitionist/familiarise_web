"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CalendarX } from "lucide-react";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { DashboardHeader } from "@/components/dashboard/DashboardShell";
import { EmptyState } from "@/components/dashboard/DataCard";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { createConsultantQueries } from "@/lib/dashboard-queries";
import { useOrgScope } from "@/hooks/useOrgScope";
import {
  OrgContextFilter,
  ORG_FILTER_ALL,
  ORG_FILTER_PERSONAL,
  type OrgContextFilterValue,
} from "@/components/dashboard/OrgContextFilter";
import { AppointmentsTab } from "./AppointmentsTab";

function AppointmentsListSkeleton() {
  return (
    <div className="rounded-xl border border-zinc-200/80 bg-white shadow-sm p-4 sm:p-6 space-y-4">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-10 w-full" />
      <div className="space-y-3">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-24 w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}

export default function AppointmentsPageClient({
  consultantId,
}: Readonly<{ consultantId: string }>) {
  // Default to "All activity" so a panel expert lands on the union view
  // (sponsored + personal) without a manual toggle every visit. Matches
  // the consultee /appointments choice we shipped earlier this branch.
  const { scope, setScope } = useOrgScope({ defaultForOrgMember: "all" });
  const orgScopeParam =
    scope.kind === "personal"
      ? "personal"
      : scope.kind === "all"
        ? "all"
        : scope.orgId;
  const orgScopeQueryParam =
    orgScopeParam && orgScopeParam !== "personal" ? orgScopeParam : null;

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

  // Use the centralized query configuration.
  // keepPreviousData: org-scope filter changes show the previous list while
  // the new one loads instead of a skeleton flash (the documents-page idiom,
  // #346).
  // #890 — the server page prefetches the "personal"-scope view; this query
  // hydrates from that cache when the resolved scope is personal, and falls
  // back to a client fetch for any other scope (org / all).
  const appointmentsQuery = createConsultantQueries(
    consultantId,
    orgScopeParam,
  ).appointments;
  const {
    data: appointments,
    isLoading,
    error,
    refetch: refetchAppointments,
  } = useQuery({
    ...appointmentsQuery,
    placeholderData: keepPreviousData,
  });

  // Auxiliary sections each carry their own query state into the tab so a
  // slow or failed trials/classes/webinars read can't blank the main list
  // (previously ONE loading flag gated the entire page).
  const {
    data: trialsData,
    isLoading: trialsLoading,
    isError: trialsError,
    refetch: refetchTrials,
  } = useQuery({
    placeholderData: keepPreviousData,
    queryKey: ["trials", consultantId, "SCHEDULED", orgScopeParam] as const,
    queryFn: async () => {
      const orgScopeQs = orgScopeQueryParam
        ? `&orgScope=${encodeURIComponent(orgScopeQueryParam)}`
        : "";
      const res = await fetch(
        `/api/trials?consultantProfileId=${consultantId}&status=SCHEDULED${orgScopeQs}`,
      );
      if (!res.ok) throw new Error("Failed to fetch trials");
      const { data } = await res.json();
      return data;
    },
  });

  const {
    data: classEventsData,
    isLoading: classesLoading,
    isError: classesError,
    refetch: refetchClasses,
  } = useQuery({
    placeholderData: keepPreviousData,
    queryKey: ["consultant-classes", consultantId, orgScopeParam] as const,
    queryFn: async () => {
      const orgScopeQs = orgScopeQueryParam
        ? `&orgScope=${encodeURIComponent(orgScopeQueryParam)}`
        : "";
      const res = await fetch(
        `/api/bookings/classes?consultantProfileId=${consultantId}${orgScopeQs}`,
      );
      if (!res.ok) throw new Error("Failed to fetch classes");
      const { data } = await res.json();
      return (data ?? []).filter(
        (c: { appointment: unknown }) => !c.appointment,
      );
    },
  });

  const {
    data: webinarEventsData,
    isLoading: webinarsLoading,
    isError: webinarsError,
    refetch: refetchWebinars,
  } = useQuery({
    placeholderData: keepPreviousData,
    queryKey: [
      "consultant-webinars-unscheduled",
      consultantId,
      orgScopeParam,
    ] as const,
    queryFn: async () => {
      const orgScopeQs = orgScopeQueryParam
        ? `&orgScope=${encodeURIComponent(orgScopeQueryParam)}`
        : "";
      const res = await fetch(
        `/api/bookings/webinars?consultantProfileId=${consultantId}${orgScopeQs}`,
      );
      if (!res.ok) throw new Error("Failed to fetch webinars");
      const { data } = await res.json();
      return (data ?? []).filter(
        (w: { appointment: unknown }) => !w.appointment,
      );
    },
  });

  return (
    <DashboardErrorBoundary>
      <DashboardHeader
        title="Appointments"
        subtitle="Your consultations, subscriptions, webinars, and classes"
      />
      <div className="pt-6">
        {isLoading ? (
          <AppointmentsListSkeleton />
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
              <Button
                variant="outline"
                onClick={() => void refetchAppointments()}
              >
                Retry
              </Button>
            }
          />
        ) : (
          <AppointmentsTab
            appointments={appointments || []}
            scheduledTrials={trialsData || []}
            trialsState={{
              isLoading: trialsLoading,
              isError: trialsError,
              onRetry: () => void refetchTrials(),
            }}
            consultantId={consultantId}
            unscheduledClasses={classEventsData || []}
            unscheduledClassesState={{
              isLoading: classesLoading,
              isError: classesError,
              onRetry: () => void refetchClasses(),
            }}
            unscheduledWebinars={webinarEventsData || []}
            unscheduledWebinarsState={{
              isLoading: webinarsLoading,
              isError: webinarsError,
              onRetry: () => void refetchWebinars(),
            }}
            headerSlot={
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
