"use client";

import { User } from "@prisma/client";
import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createConsulteeQueries } from "@/hooks/useConsulteePrefetchDashboard";
import { EventWithType } from "../../utils/getMetadata";
import {
  getActualMonthlyEvents,
  getActualUpcomingSlots,
} from "../../utils/scheduleHelpers";
import { MonthlySection, UpcomingSection } from "./Sections";
import { ConsulteeDashboardSkeleton } from "@/components/ui/dashboard-skeleton";

interface HomeTabProps {
  userDetails: User | null;
  params: Promise<{ consulteeId: string }>;
}

export default function HomeTab({
  userDetails,
  params,
}: Readonly<HomeTabProps>) {
  const resolvedParams = React.use(params);
  const consulteeId = resolvedParams.consulteeId;
  
  // Use the centralized query configuration
  const eventsQuery = createConsulteeQueries(consulteeId).events;
  const { data, isLoading, error } = useQuery(eventsQuery);
  
  const [currentMonth, setCurrentMonth] = useState(new Date());

  if (!userDetails || isLoading) {
    return <ConsulteeDashboardSkeleton />;
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="p-4 bg-red-50 text-red-600 rounded-lg max-w-md text-center">
          <h3 className="font-semibold mb-2">Error Loading Events</h3>
          <p className="text-sm">
            {error.message || "Failed to load events data. Please try again."}
          </p>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!data) {
    return <ConsulteeDashboardSkeleton />;
  }

  const allEvents: EventWithType[] = [
    ...data.consultations.map((c: any) => ({ ...c, type: "Consultation" as const })),
    ...data.webinars.map((w: any) => ({ ...w, type: "Webinar" as const })),
    ...data.subscriptions.map((s: any) => ({ ...s, type: "Subscription" as const })),
    ...data.classes.map((c: any) => ({ ...c, type: "Class" as const })),
  ];

  const upcomingSlots = getActualUpcomingSlots(allEvents);
  const monthlyEvents = getActualMonthlyEvents(allEvents, currentMonth);

  const goToPreviousMonth = () => {
    setCurrentMonth(
      new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1),
    );
  };

  const goToNextMonth = () => {
    setCurrentMonth(
      new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1),
    );
  };

  return (
    <div className="space-y-6 min-h-[calc(100vh-200px)] p-6 bg-gray-50">
      {/* Welcome Section */}
      <div className="bg-white rounded-xl p-6">
        <h2 className="text-2xl font-bold text-blue-600">
          Welcome back, {userDetails.name}
        </h2>
        <p className="mt-1 text-gray-600">
          Here's what's coming up in your learning journey
        </p>
      </div>

      {/* Upcoming Sessions */}
      <UpcomingSection slots={upcomingSlots} />

      {/* Monthly Events and Premium Features */}
      <MonthlySection
        currentMonth={currentMonth}
        events={monthlyEvents}
        onPreviousMonth={goToPreviousMonth}
        onNextMonth={goToNextMonth}
      />
    </div>
  );
}
