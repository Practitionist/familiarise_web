"use client";

import { User } from "@prisma/client";
import React, { useState } from "react";
import { EventWithType } from "../../utils/getMetadata";
import {
  getActualMonthlyEvents,
  getActualUpcomingSlots,
} from "../../utils/scheduleHelpers";
import { MonthlySection, UpcomingSection } from "./Sections";

interface HomeTabProps {
  userDetails: User | null;
  eventsData: any; // Events data passed from parent
  isRefreshing?: boolean;
}

export default function HomeTab({
  userDetails,
  eventsData,
  isRefreshing = false,
}: Readonly<HomeTabProps>) {
  const [currentMonth, setCurrentMonth] = useState(new Date());

  if (!userDetails || !eventsData) {
    return (
      <div className="space-y-6 min-h-[calc(100vh-200px)] p-6 bg-gray-50">
        <div className="bg-white rounded-xl p-6">
          <h2 className="text-2xl font-bold text-blue-600">
            Welcome back
          </h2>
          <p className="mt-1 text-gray-600">
            Loading your dashboard...
          </p>
        </div>
      </div>
    );
  }

  const allEvents: EventWithType[] = [
    ...eventsData.consultations.map((c: any) => ({
      ...c,
      type: "Consultation" as const,
    })),
    ...eventsData.webinars.map((w: any) => ({ ...w, type: "Webinar" as const })),
    ...eventsData.subscriptions.map((s: any) => ({
      ...s,
      type: "Subscription" as const,
    })),
    ...eventsData.classes.map((c: any) => ({ ...c, type: "Class" as const })),
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
      {/* Show subtle loading indicator when refreshing */}
      {isRefreshing && (
        <div className="fixed top-4 right-4 bg-blue-500 text-white px-3 py-1 rounded-md text-sm z-50">
          Refreshing...
        </div>
      )}
      
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
