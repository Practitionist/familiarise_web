"use client";

import { use } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { PageSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { createConsultantQueries } from "@/lib/dashboard-queries";
import { useOrgScope } from "@/hooks/useOrgScope";
import {
  OrgContextFilter,
  ORG_FILTER_ALL,
  ORG_FILTER_PERSONAL,
  type OrgContextFilterValue,
} from "@/components/dashboard/OrgContextFilter";
import { BADGE_STYLES } from "../../types";
import { AppointmentsTab } from "./AppointmentsTab";

export default function AppointmentsPage({
  params,
}: {
  params: Promise<{ consultantId: string }>;
}) {
  const { consultantId } = use(params);

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
  const appointmentsQuery = createConsultantQueries(
    consultantId,
    orgScopeParam,
  ).appointments;
  const { data: appointments, isLoading, error } = useQuery({
    ...appointmentsQuery,
    placeholderData: keepPreviousData,
  });

  // Fetch scheduled trials for this consultant
  const { data: trialsData, isLoading: trialsLoading } = useQuery({
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

  // Fetch class events for this consultant (to show unscheduled classes in appointments page)
  const { data: classEventsData, isLoading: classesLoading } = useQuery({
    placeholderData: keepPreviousData,
    queryKey: ["consultant-classes", consultantId, orgScopeParam] as const,
    queryFn: async () => {
      const orgScopeQs = orgScopeQueryParam
        ? `&orgScope=${encodeURIComponent(orgScopeQueryParam)}`
        : "";
      const res = await fetch(
        `/api/events/classes?consultantProfileId=${consultantId}${orgScopeQs}`,
      );
      if (!res.ok) throw new Error("Failed to fetch classes");
      const { data } = await res.json();
      return (data ?? []).filter(
        (c: { appointment: unknown }) => !c.appointment,
      );
    },
  });

  // Fetch webinar events for this consultant; filter to those with no appointment yet
  const { data: webinarEventsData, isLoading: webinarsLoading } = useQuery({
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
        `/api/events/webinars?consultantProfileId=${consultantId}${orgScopeQs}`,
      );
      if (!res.ok) throw new Error("Failed to fetch webinars");
      const { data } = await res.json();
      return (data ?? []).filter(
        (w: { appointment: unknown }) => !w.appointment,
      );
    },
  });

  if (isLoading || trialsLoading || classesLoading || webinarsLoading) {
    return <PageSkeleton />;
  }

  if (error) {
    return (
      <DashboardErrorBoundary>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="p-4 bg-red-50 text-red-600 rounded-lg max-w-md text-center">
            <h3 className="font-semibold mb-2">Error Loading Appointments</h3>
            <p className="text-sm">
              {error.message ||
                "Failed to load appointments. Please try again."}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="mt-4 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
            >
              Retry
            </button>
          </div>
        </div>
      </DashboardErrorBoundary>
    );
  }

  return (
    <DashboardErrorBoundary>
      <AppointmentsTab
        appointments={appointments || []}
        badgeStyles={BADGE_STYLES}
        scheduledTrials={trialsData || []}
        consultantId={consultantId}
        unscheduledClasses={classEventsData || []}
        unscheduledWebinars={webinarEventsData || []}
        headerSlot={
          <OrgContextFilter
            value={filterValue}
            onChange={handleFilterChange}
          />
        }
      />
    </DashboardErrorBoundary>
  );
}
