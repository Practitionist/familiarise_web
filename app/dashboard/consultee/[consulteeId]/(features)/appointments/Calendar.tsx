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
  TrialWithPlan,
} from "@/hooks/useEvents";
import { getStatusColor } from "../../utils/getMetadata";
import { getActualSlots } from "../../utils/scheduleHelpers";

interface CalendarProps {
  consultations: ConsultationWithPlan[];
  subscriptions: SubscriptionWithPlan[];
  webinars: WebinarWithPlan[];
  classes: ClassWithPlan[];
  trials: TrialWithPlan[];
}

type Event = {
  id: string;
  title: string;
  start: Date;
  end: Date;
  type: "Consultation" | "Subscription" | "Webinar" | "Class" | "Trial";
  status: string;
  consultant: string;
  subscriptionId?: string | null;
  time?: string;
  isTentative?: boolean;
};

export function Calendar({
  consultations,
  subscriptions,
  webinars,
  classes,
  trials,
}: Readonly<CalendarProps>) {
  const [currentDate, setCurrentDate] = useState(new Date());

  // Generate unique colors for each subscription
  const subscriptionColors = React.useMemo(() => {
    const colors: { [key: string]: string } = {};
    const baseColors = [
      "bg-blue-200 text-blue-900",
      "bg-purple-200 text-purple-900",
      "bg-pink-200 text-pink-900",
      "bg-indigo-200 text-indigo-900",
      "bg-cyan-200 text-cyan-900",
      "bg-teal-200 text-teal-900",
    ];

    subscriptions.forEach((s, index) => {
      colors[s.id] = baseColors[index % baseColors.length];
    });
    return colors;
  }, [subscriptions]);

  const events: Event[] = React.useMemo(
    () =>
      [
        ...consultations.flatMap((c) => {
          const slots = getActualSlots({ ...c, type: "Consultation" });
          return slots.map((slot) => {
            const startTime = new Date(slot.startsAt);
            return {
              id: `${c.id}-${startTime.getTime()}`,
              title: c.consultationPlan.title,
              start: startTime,
              end: slot.endsAt
                ? new Date(slot.endsAt)
                : new Date(startTime.getTime() + 60 * 60 * 1000),
              type: "Consultation" as const,
              status: c.requestStatus,
              consultant:
                c.consultationPlan.consultantProfile?.user?.name || "Unknown",
              subscriptionId: null,
              time: startTime.toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              }),
              isTentative: slot.isTentative,
            };
          });
        }),
        ...subscriptions.flatMap((s) => {
          const slots = getActualSlots({ ...s, type: "Subscription" });
          return slots.map((slot) => {
            const startTime = new Date(slot.startsAt);
            return {
              id: `${s.id}-${startTime.getTime()}`,
              title: s.subscriptionPlan.title,
              start: startTime,
              end: slot.endsAt
                ? new Date(slot.endsAt)
                : new Date(startTime.getTime() + 60 * 60 * 1000),
              type: "Subscription" as const,
              status: s.requestStatus,
              consultant:
                s.subscriptionPlan.consultantProfile?.user?.name || "Unknown",
              subscriptionId: s.id,
              time: startTime.toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              }),
              isTentative: slot.isTentative,
            };
          });
        }),
        ...classes.flatMap((c) => {
          const slots = getActualSlots({ ...c, type: "Class" });
          return slots.map((slot) => {
            const startTime = new Date(slot.startsAt);
            return {
              id: `${c.id}-${startTime.getTime()}`,
              title: c.classPlan.title,
              start: startTime,
              end: slot.endsAt
                ? new Date(slot.endsAt)
                : new Date(startTime.getTime() + 60 * 60 * 1000),
              type: "Class" as const,
              status: c.status,
              consultant:
                c.classPlan.consultantProfile?.user?.name || "Unknown",
              time: startTime.toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              }),
              isTentative: slot.isTentative,
            };
          });
        }),
        ...webinars.flatMap((w) => {
          const slots = getActualSlots({ ...w, type: "Webinar" });
          return slots.map((slot) => {
            const startTime = new Date(slot.startsAt);
            return {
              id: `${w.id}-${startTime.getTime()}`,
              title: w.webinarPlan.title,
              start: startTime,
              end: slot.endsAt
                ? new Date(slot.endsAt)
                : new Date(startTime.getTime() + 60 * 60 * 1000),
              type: "Webinar" as const,
              status: w.status,
              consultant:
                w.webinarPlan.consultantProfile?.user?.name || "Unknown",
              time: startTime.toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              }),
              isTentative: slot.isTentative,
            };
          });
        }),
        // Trial sessions
        ...trials.flatMap((t) => {
          const slots = t.appointment?.slotsOfAppointment ?? [];
          return slots.map((slot) => {
            const startTime = new Date(slot.startsAt);
            const durationMs = (t.subscriptionPlan.freeTrialDurationMinutes || 30) * 60 * 1000;
            return {
              id: `${t.id}-${startTime.getTime()}`,
              title: `Free Trial: ${t.subscriptionPlan.title}`,
              start: startTime,
              end: new Date(startTime.getTime() + durationMs),
              type: "Trial" as const,
              status: t.status,
              consultant:
                t.subscriptionPlan.consultantProfile?.user?.name || "Unknown",
              time: startTime.toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              }),
              isTentative: false,
            };
          });
        }),
      ].filter((event) => {
        const startTime = event.start.getTime();
        if (isNaN(startTime)) {
          console.log("Invalid date for event:", event.title);
          return false;
        }
        // Skip dates from 1970 (Unix epoch)
        if (event.start.getFullYear() === 1970) {
          console.log("Skipping 1970 date for event:", event.title);
          return false;
        }
        return true;
      }),
    [consultations, subscriptions, webinars, classes, trials],
  );

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

  const getEventColor = (event: Event) => {
    if (event.type === "Subscription" && event.subscriptionId) {
      return subscriptionColors[event.subscriptionId];
    }
    return getStatusColor(event.status);
  };

  const handleEventClick = (event: Event) => {
    console.log("Calendar event clicked:", {
      id: event.id,
      title: event.title,
      type: event.type,
      status: event.status,
      consultant: event.consultant,
      start: event.start,
      end: event.end,
      isTentative: event.isTentative,
    });
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
            onClick={() =>
              setCurrentDate(
                new Date(
                  currentDate.getFullYear(),
                  currentDate.getMonth() - 1,
                  1,
                ),
              )
            }
            className="rounded-full"
          >
            <ArrowLeftIcon className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() =>
              setCurrentDate(
                new Date(
                  currentDate.getFullYear(),
                  currentDate.getMonth() + 1,
                  1,
                ),
              )
            }
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
            const dayNumber =
              i -
              new Date(
                currentDate.getFullYear(),
                currentDate.getMonth(),
                1,
              ).getDay() +
              1;
            const isCurrentMonth =
              dayNumber > 0 &&
              dayNumber <=
                new Date(
                  currentDate.getFullYear(),
                  currentDate.getMonth() + 1,
                  0,
                ).getDate();
            const dayEvents = isCurrentMonth ? getEventsForDay(dayNumber) : [];

            return (
              <div
                key={`day-${i}`}
                className={`min-h-[100px] p-2 bg-white ${
                  isCurrentMonth ? "" : "text-gray-400"
                }`}
              >
                <div className="font-medium mb-1">
                  {isCurrentMonth ? dayNumber : ""}
                </div>
                <div className="space-y-1">
                  {dayEvents.map((event) => (
                    <button
                      key={event.id}
                      onClick={() => handleEventClick(event)}
                      className={`w-full text-left text-xs p-1.5 rounded truncate font-medium hover:opacity-80 focus:ring-2 focus:ring-offset-1 focus:outline-none ${getEventColor(event)}`}
                      title={`${event.title} - ${event.consultant} - ${event.time} - ${event.status}${event.isTentative ? " (Subject to change)" : ""}`}
                    >
                      <div className="flex justify-between items-center">
                        <div className="flex flex-col">
                          <span>{event.title}</span>
                          <span className="text-xs opacity-75">
                            {event.status}
                            {event.isTentative && (
                              <span className="ml-1 text-red-500">*</span>
                            )}
                          </span>
                        </div>
                        <span className="font-bold">{event.time}</span>
                      </div>
                    </button>
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
