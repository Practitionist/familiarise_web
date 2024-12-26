"use client";

import React, { useState, useMemo } from "react";
import { convertUTCToZoneTime } from "@/lib/datetimetz";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeftIcon, ArrowRightIcon } from "@/assets/icons";
import {
  ConsultationWithPlan,
  SubscriptionWithPlan,
  WebinarWithPlan,
  ClassWithPlan,
} from "@/hooks/useEvents";
import { TAppointment } from "@/types/appointment";

interface CalendarProps {
  consultations: ConsultationWithPlan[];
  subscriptions: SubscriptionWithPlan[];
  webinars: WebinarWithPlan[];
  classes: ClassWithPlan[];
}

type Event = {
  id?: string;
  title: string;
  start: Date;
  end: Date;
  type: "Consultation" | "Subscription" | "Webinar" | "Class";
  status: string;
  consultant: string;
  subscriptionId?: string | null;
  time?: string;
};

interface ScheduleSlot {
  startTime: string;
  endTime: string;
  timezone: string;
}

export function Calendar({
  consultations,
  subscriptions,
  webinars,
  classes,
}: CalendarProps) {
  const [currentDate, setCurrentDate] = useState(new Date());

  // Generate unique colors for each subscription
  const subscriptionColors = useMemo(() => {
    const colors: { [key: string]: string } = {};
    const baseColors = [
      'bg-blue-100 text-blue-800',
      'bg-purple-100 text-purple-800',
      'bg-pink-100 text-pink-800',
      'bg-indigo-100 text-indigo-800',
      'bg-cyan-100 text-cyan-800',
      'bg-teal-100 text-teal-800',
    ];
    
    subscriptions.forEach((s, index) => {
      colors[s.id] = baseColors[index % baseColors.length];
    });
    return colors;
  }, [subscriptions]);

  const events: Event[] = useMemo(() => [
    ...consultations.map((c) => {
      const dateStr = typeof c.preferredDateTime === 'string' ? c.preferredDateTime : c.preferredDateTime?.toString() || "";
      const localTime = convertUTCToZoneTime(dateStr, Intl.DateTimeFormat().resolvedOptions().timeZone);
      return {
        id: c.id,
        title: c.consultationPlan.title,
        start: c.preferredDateTime ? new Date(c.preferredDateTime) : new Date(),
        end: c.preferredDateTime ? new Date(new Date(c.preferredDateTime).getTime() + 60 * 60 * 1000) : new Date(),
        type: "Consultation" as const,
        status: c.requestStatus,
        consultant: c.consultationPlan.consultantProfile?.user?.name || "Unknown",
        subscriptionId: null,
        time: localTime?.split(' ')[1] || '',
      };
    }),
    ...subscriptions.flatMap((s) => {
      try {
        const schedule: ScheduleSlot[] = s.tentativeSchedule ? JSON.parse(s.tentativeSchedule) : [];
        return schedule.map((slot) => {
          const localTime = convertUTCToZoneTime(slot.startTime, Intl.DateTimeFormat().resolvedOptions().timeZone);
          return {
            id: `${s.id}-${slot.startTime}`,
            title: s.subscriptionPlan.title,
            start: new Date(slot.startTime),
            end: new Date(slot.endTime),
            type: "Subscription" as const,
            status: s.requestStatus,
            consultant: s.subscriptionPlan.consultantProfile?.user?.name || "Unknown",
            subscriptionId: s.id,
            time: localTime?.split(' ')[1] || '',
          };
        });
      } catch (e) {
        console.error('Error parsing subscription schedule:', e);
        return [];
      }
    }),
    ...classes.flatMap((c) => {
      try {
        const schedule: ScheduleSlot[] = c.tentativeSchedule ? JSON.parse(c.tentativeSchedule) : [];
        return schedule.map((slot) => {
          const localTime = convertUTCToZoneTime(slot.startTime, Intl.DateTimeFormat().resolvedOptions().timeZone);
          return {
            id: `${c.id}-${slot.startTime}`,
            title: c.classPlan.title,
            start: new Date(slot.startTime),
            end: new Date(slot.endTime),
            type: "Class" as const,
            status: c.status,
            consultant: c.classPlan.consultantProfile?.user?.name || "Unknown",
            time: localTime?.split(' ')[1] || '',
          };
        });
      } catch (e) {
        console.error('Error parsing class schedule:', e);
        return [];
      }
    }),
    ...webinars.map((w) => {
      const localTime = convertUTCToZoneTime(
        typeof w.scheduledAt === 'string' ? w.scheduledAt : w.scheduledAt?.toString() || "", 
        Intl.DateTimeFormat().resolvedOptions().timeZone
      );
      return {
        id: w.id,
        title: w.webinarPlan.title,
        start: w.scheduledAt ? new Date(w.scheduledAt) : new Date(),
        end: w.endAt ? new Date(w.endAt) : new Date(),
        type: "Webinar" as const,
        status: w.status,
        consultant: w.webinarPlan.consultantProfile?.user?.name || "Unknown",
        time: localTime?.split(' ')[1] || '',
      };
    }),
  ].filter((event) => !isNaN(event.start.getTime())), [consultations, subscriptions, webinars, classes]);

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

  const getEventColor = (event: Event) => {
    if (event.type === "Subscription" && event.subscriptionId) {
      return subscriptionColors[event.subscriptionId];
    }
    
    const statusLower = event.status.toLowerCase();
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
                      className={`text-xs p-1 rounded truncate ${getEventColor(event)}`}
                      title={`${event.title} - ${event.consultant} - ${event.time}`}
                    >
                      {event.title} - {event.time}
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
