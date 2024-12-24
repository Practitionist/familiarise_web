"use client";

import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { ArrowLeftIcon, ArrowRightIcon } from "@/assets/icons";
import {
  ConsultationWithPlan,
  SubscriptionWithPlan,
  WebinarWithPlan,
  ClassWithPlan,
} from "@/hooks/useEvents";
import { EventCard } from "./EventCard";

interface UpcomingProps {
  consultations: ConsultationWithPlan[];
  subscriptions: SubscriptionWithPlan[];
  webinars: WebinarWithPlan[];
  classes: ClassWithPlan[];
}

export function Upcoming({
  consultations,
  subscriptions,
  webinars,
  classes,
}: UpcomingProps) {
  const [currentMonth, setCurrentMonth] = useState(new Date());

  // Filter and sort upcoming events
  const upcomingEvents = [
    ...consultations.map((c) => ({
      type: "Consultation" as const,
      title: c.consultationPlan.title,
      date: new Date(c.preferredDateTime || ""),
      consultant:
        c.consultationPlan.consultantProfile?.user?.name ||
        "Unknown Consultant",
      image: c.consultationPlan.consultantProfile?.user?.image,
      status: c.requestStatus,
    })),
    ...subscriptions.map((s) => ({
      type: "Subscription" as const,
      title: s.subscriptionPlan.title,
      date: new Date(s.startDate || ""),
      consultant:
        s.subscriptionPlan.consultantProfile?.user?.name ||
        "Unknown Consultant",
      image: s.subscriptionPlan.consultantProfile?.user?.image,
      status: s.requestStatus,
    })),
    ...webinars.map((w) => ({
      type: "Webinar" as const,
      title: w.webinarPlan.title,
      date: new Date(w.scheduledAt || ""),
      consultant:
        w.webinarPlan.consultantProfile?.user?.name || "Unknown Consultant",
      image: w.webinarPlan.consultantProfile?.user?.image,
      status: w.status,
    })),
    ...classes.map((c) => ({
      type: "Class" as const,
      title: c.classPlan.title,
      date: new Date(c.startDate || ""),
      consultant:
        c.classPlan.consultantProfile?.user?.name || "Unknown Consultant",
      image: c.classPlan.consultantProfile?.user?.image,
      status: c.status,
    })),
  ]
    .filter((event) => !isNaN(event.date.getTime()) && event.date >= new Date())
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  // Filter events for current month
  const eventsForCurrentMonth = upcomingEvents.filter(
    (event) =>
      event.date.getMonth() === currentMonth.getMonth() &&
      event.date.getFullYear() === currentMonth.getFullYear(),
  );

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
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <h2 className="text-2xl font-semibold text-gray-900">
          Upcoming Events
        </h2>
        <div className="flex items-center space-x-4 bg-white rounded-lg shadow-sm p-2">
          <Button
            onClick={goToPreviousMonth}
            variant="outline"
            size="icon"
            className="hover:bg-gray-50"
          >
            <ArrowLeftIcon className="h-4 w-4" />
          </Button>
          <p className="text-sm font-medium text-gray-900 min-w-[120px] text-center">
            {currentMonth.toLocaleString("default", {
              month: "long",
              year: "numeric",
            })}
          </p>
          <Button
            onClick={goToNextMonth}
            variant="outline"
            size="icon"
            className="hover:bg-gray-50"
          >
            <ArrowRightIcon className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="space-y-4">
        {eventsForCurrentMonth.map((event, index) => (
          <EventCard
            key={index}
            title={event.title}
            consultant={event.consultant}
            date={event.date.toLocaleString()}
            image={event.image}
            status={event.status}
          />
        ))}
        {eventsForCurrentMonth.length === 0 && (
          <div className="text-center py-8 bg-white rounded-lg border border-dashed border-gray-200">
            <p className="text-gray-500">No upcoming events for this month</p>
          </div>
        )}
      </div>
    </div>
  );
}
