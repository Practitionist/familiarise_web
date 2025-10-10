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
    ...data.consultations.map((c: any) => ({
      ...c,
      type: "Consultation" as const,
    })),
    ...data.webinars.map((w: any) => ({ ...w, type: "Webinar" as const })),
    ...data.subscriptions.map((s: any) => ({
      ...s,
      type: "Subscription" as const,
    })),
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
    <div className="space-y-8 min-h-[calc(100vh-200px)] animate-fade-in">
      {/* Welcome Section */}
      <div className="relative overflow-hidden bg-gradient-to-br from-blue-600 via-indigo-600 to-purple-600 rounded-2xl p-8 shadow-xl">
        <div className="absolute inset-0 bg-grid-white/10 [mask-image:linear-gradient(0deg,transparent,white)]"></div>
        <div className="relative z-10">
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-2">
            Welcome back, {userDetails.name}
          </h2>
          <p className="text-blue-100 text-lg">
            Here's what's coming up in your learning journey
          </p>
        </div>
        <div className="absolute -right-10 -bottom-10 w-40 h-40 bg-white/10 rounded-full blur-3xl"></div>
        <div className="absolute -left-10 -top-10 w-32 h-32 bg-purple-300/20 rounded-full blur-2xl"></div>
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
