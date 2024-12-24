"use client";

import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeftIcon, ArrowRightIcon } from "@/assets/icons";
import {
  ConsultationWithPlan,
  SubscriptionWithPlan,
  WebinarWithPlan,
  ClassWithPlan,
} from "@/hooks/useEvents";

interface CalendarProps {
  consultations: ConsultationWithPlan[];
  subscriptions: SubscriptionWithPlan[];
  webinars: WebinarWithPlan[];
  classes: ClassWithPlan[];
}

type Event = {
  title: string;
  start: Date;
  end: Date;
  type: "Consultation" | "Subscription" | "Webinar" | "Class";
  status: string;
  consultant: string;
};

export function Calendar({
  consultations,
  subscriptions,
  webinars,
  classes,
}: CalendarProps) {
  const [currentDate, setCurrentDate] = useState(new Date());

  // Convert all events to a common format
  const events: Event[] = [
    ...consultations.map((c) => ({
      title: c.consultationPlan.title,
      start: new Date(c.preferredDateTime || ""),
      end: new Date(
        new Date(c.preferredDateTime || "").getTime() + 60 * 60 * 1000,
      ), // 1 hour duration
      type: "Consultation" as const,
      status: c.requestStatus,
      consultant: c.consultationPlan.consultantProfile?.user?.name || "Unknown",
    })),
    ...subscriptions.map((s) => ({
      title: s.subscriptionPlan.title,
      start: new Date(s.startDate || ""),
      end: new Date(s.endDate || ""),
      type: "Subscription" as const,
      status: s.requestStatus,
      consultant: s.subscriptionPlan.consultantProfile?.user?.name || "Unknown",
    })),
    ...webinars.map((w) => ({
      title: w.webinarPlan.title,
      start: new Date(w.scheduledAt || ""),
      end: new Date(w.endAt || ""),
      type: "Webinar" as const,
      status: w.status,
      consultant: w.webinarPlan.consultantProfile?.user?.name || "Unknown",
    })),
    ...classes.map((c) => ({
      title: c.classPlan.title,
      start: new Date(c.startDate || ""),
      end: new Date(c.endDate || ""),
      type: "Class" as const,
      status: c.status,
      consultant: c.classPlan.consultantProfile?.user?.name || "Unknown",
    })),
  ].filter((event) => !isNaN(event.start.getTime()));

  const daysInMonth = new Date(
    currentDate.getFullYear(),
    currentDate.getMonth() + 1,
    0,
  ).getDate();

  const firstDayOfMonth = new Date(
    currentDate.getFullYear(),
    currentDate.getMonth(),
    1,
  ).getDay();

  const goToPreviousMonth = () => {
    setCurrentDate(
      new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1),
    );
  };

  const goToNextMonth = () => {
    setCurrentDate(
      new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1),
    );
  };

  const getEventsForDay = (day: number) => {
    return events.filter((event) => {
      const eventDate = new Date(event.start);
      return (
        eventDate.getDate() === day &&
        eventDate.getMonth() === currentDate.getMonth() &&
        eventDate.getFullYear() === currentDate.getFullYear()
      );
    });
  };

  const getStatusColor = (status: string) => {
    const statusLower = status.toLowerCase();
    if (statusLower === "completed") return "bg-green-100 text-green-800";
    if (statusLower === "rejected") return "bg-red-100 text-red-800";
    if (statusLower === "pending") return "bg-yellow-100 text-yellow-800";
    return "bg-gray-100 text-gray-800";
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-semibold">
          {currentDate.toLocaleString("default", {
            month: "long",
            year: "numeric",
          })}
        </h2>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={goToPreviousMonth}
            className="rounded-full"
          >
            <ArrowLeftIcon className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={goToNextMonth}
            className="rounded-full"
          >
            <ArrowRightIcon className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <Card className="p-4">
        <div className="grid grid-cols-7 gap-px bg-gray-200">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
            <div key={day} className="p-2 text-center font-semibold bg-white">
              {day}
            </div>
          ))}
          {Array.from({ length: 42 }, (_, i) => {
            const dayNumber = i - firstDayOfMonth + 1;
            const isCurrentMonth = dayNumber > 0 && dayNumber <= daysInMonth;
            const dayEvents = isCurrentMonth ? getEventsForDay(dayNumber) : [];

            return (
              <div
                key={i}
                className={`min-h-[100px] p-2 bg-white ${
                  isCurrentMonth ? "" : "text-gray-400"
                }`}
              >
                <div className="font-medium mb-1">
                  {isCurrentMonth ? dayNumber : ""}
                </div>
                <div className="space-y-1">
                  {dayEvents.map((event, index) => (
                    <div
                      key={index}
                      className={`text-xs p-1 rounded truncate ${getStatusColor(event.status)}`}
                      title={`${event.title} - ${event.consultant}`}
                    >
                      {event.title}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
