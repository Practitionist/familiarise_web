"use client";

import { User } from "@prisma/client";
import React, { useState } from "react";
import { useEvents } from "hooks/useEvents";
import { EventWithType } from "../../utils";
import {
  getActualMonthlyEvents,
  getActualUpcomingSlots,
} from "../../utils/actual-schedule";
import { MonthlySection, UpcomingSection } from "./Sections";

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
  const { consultations, subscriptions, webinars, classes, isLoading, error } =
    useEvents(consulteeId);
  const [currentMonth, setCurrentMonth] = useState(new Date());

  if (!userDetails || isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-pulse text-gray-500">Loading user data...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-50 text-red-600 rounded-lg">
        Error loading events: {error.message}
      </div>
    );
  }

  const allEvents: EventWithType[] = [
    ...consultations.map((c) => ({ ...c, type: "Consultation" as const })),
    ...webinars.map((w) => ({ ...w, type: "Webinar" as const })),
    ...subscriptions.map((s) => ({ ...s, type: "Subscription" as const })),
    ...classes.map((c) => ({ ...c, type: "Class" as const })),
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
