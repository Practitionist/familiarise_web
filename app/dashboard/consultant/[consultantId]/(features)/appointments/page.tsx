"use client";

import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { PageSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { createConsultantQueries } from "@/lib/dashboard-queries";
import { BADGE_STYLES } from "../../types";
import { AppointmentsTab } from "./AppointmentsTab";

export default function AppointmentsPage({
  params,
}: {
  params: Promise<{ consultantId: string }>;
}) {
  const { consultantId } = use(params);

  // Use the centralized query configuration
  const appointmentsQuery = createConsultantQueries(consultantId).appointments;
  const { data: appointments, isLoading, error } = useQuery(appointmentsQuery);

  // Fetch scheduled trials for this consultant
  const { data: trialsData, isLoading: trialsLoading } = useQuery({
    queryKey: ["trials", consultantId, "SCHEDULED"],
    queryFn: async () => {
      const res = await fetch(
        `/api/trials?consultantProfileId=${consultantId}&status=SCHEDULED`,
      );
      if (!res.ok) throw new Error("Failed to fetch trials");
      const { data } = await res.json();
      return data;
    },
  });

  // Fetch class events for this consultant (to show unscheduled classes in appointments page)
  const { data: classEventsData, isLoading: classesLoading } = useQuery({
    queryKey: ["consultant-classes", consultantId],
    queryFn: async () => {
      const res = await fetch(
        `/api/events/classes?consultantProfileId=${consultantId}`,
      );
      if (!res.ok) throw new Error("Failed to fetch classes");
      const { data } = await res.json();
      return data;
    },
  });

  // Fetch webinar events for this consultant; filter to those with no appointment yet
  const { data: webinarEventsData, isLoading: webinarsLoading } = useQuery({
    queryKey: ["consultant-webinars-unscheduled", consultantId],
    queryFn: async () => {
      const res = await fetch(
        `/api/events/webinars?consultantProfileId=${consultantId}`,
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
      />
    </DashboardErrorBoundary>
  );
}
