"use client";

import { ArrowLeftIcon, ArrowRightIcon } from "@/assets/icons";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useEvents } from "@/hooks/useEvents";
import { User } from "@prisma/client";
import { motion } from "framer-motion";
import React, { useRef, useState } from "react";
import { Advertisement } from "../components/Advertisement";
import {
  EventWithType,
  getConsultantImage,
  getConsultantInitial,
  getConsultantName,
  getEventStatus,
  getEventTitle,
  getStatusColor,
} from "../utils";
import {
  formatTimeUntil,
  getActualMonthlyEvents,
  getActualUpcomingSlots,
  SlotWithStatus,
} from "../utils/actual-schedule";

interface HomeTabProps {
  userDetails: User | null;
  consulteeId: string;
}

export default function HomeTab({
  userDetails,
  consulteeId,
}: Readonly<HomeTabProps>) {
  const { consultations, subscriptions, webinars, classes, isLoading, error } =
    useEvents(consulteeId);
  const [currentMonth, setCurrentDate] = useState(new Date());
  const carouselRef = useRef<HTMLDivElement>(null);

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

  // Combine all events
  const allEvents: EventWithType[] = [
    ...consultations.map((c) => ({ ...c, type: "Consultation" as const })),
    ...webinars.map((w) => ({ ...w, type: "Webinar" as const })),
    ...subscriptions.map((s) => ({ ...s, type: "Subscription" as const })),
    ...classes.map((c) => ({ ...c, type: "Class" as const })),
  ];

  // Get chronological slots for top row
  const upcomingSlots = getActualUpcomingSlots(allEvents);

  // Get monthly grouped events for bottom row
  const monthlyEvents = getActualMonthlyEvents(allEvents, currentMonth);

  const scrollCarousel = (direction: "left" | "right") => {
    if (carouselRef.current) {
      const scrollAmount = 300;
      const newScrollLeft =
        carouselRef.current.scrollLeft +
        (direction === "left" ? -scrollAmount : scrollAmount);
      carouselRef.current.scrollTo({
        left: newScrollLeft,
        behavior: "smooth",
      });
    }
  };

  const goToPreviousMonth = () => {
    setCurrentDate(
      new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1),
    );
  };

  const goToNextMonth = () => {
    setCurrentDate(
      new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1),
    );
  };

  return (
    <div className="space-y-8 min-h-[calc(100vh-200px)] p-6 bg-gray-50">
      {/* Welcome Section */}
      <div className="bg-white rounded-xl p-8 shadow-sm border border-gray-100">
        <h2 className="text-3xl font-bold text-gray-900">
          Welcome back, {userDetails.name}
        </h2>
        <p className="mt-2 text-gray-600">
          Here's what's coming up in your learning journey
        </p>
      </div>

      {/* Top Row - Chronological Slots */}
      <div className="relative bg-white rounded-xl p-8 shadow-sm border border-gray-100">
        <div className="flex justify-between items-center mb-8">
          <h2 className="text-xl font-semibold text-gray-900">
            Upcoming Sessions
          </h2>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={() => scrollCarousel("left")}
              className="rounded-full"
            >
              <ArrowLeftIcon className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={() => scrollCarousel("right")}
              className="rounded-full"
            >
              <ArrowRightIcon className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div
          ref={carouselRef}
          className="flex overflow-x-auto gap-6 pb-4 scrollbar-hide scroll-smooth"
          style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
        >
          {upcomingSlots.map((slot) => (
            <div
              key={`${slot.event.id}-${slot.slotTime.getTime()}`}
              className="flex-none w-[320px]"
            >
              <SlotCard
                event={slot.event}
                slotTime={slot.slotTime}
                isTentative={slot.isTentative}
              />
            </div>
          ))}
          {upcomingSlots.length === 0 && (
            <div className="w-full text-center py-12">
              <p className="text-gray-500">No upcoming sessions</p>
            </div>
          )}
        </div>
      </div>

      {/* Bottom Section - Monthly Events and Advertisement */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Monthly Events */}
        <div className="bg-white rounded-xl p-8 shadow-sm border border-gray-100">
          <div className="flex justify-between items-center mb-8">
            <h2 className="text-xl font-semibold text-gray-900">
              {currentMonth.toLocaleString("default", {
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
          <div className="space-y-6 max-h-[600px] overflow-y-auto pr-2">
            {monthlyEvents.map(({ event, slots }) => (
              <MonthlyEventCard
                key={`${event.id}-${slots[0]?.date.getTime()}`}
                event={event}
                slots={slots}
              />
            ))}
            {monthlyEvents.length === 0 && (
              <div className="text-center py-12 bg-gray-50 rounded-lg border border-dashed border-gray-200">
                <p className="text-gray-500">No sessions this month</p>
              </div>
            )}
          </div>
        </div>

        {/* Advertisement */}
        <div className="lg:h-full">
          <Advertisement />
        </div>
      </div>
    </div>
  );
}

function SlotCard({
  event,
  slotTime,
  isTentative,
}: Readonly<{
  event: EventWithType;
  slotTime: Date;
  isTentative: boolean;
}>) {
  const now = new Date();
  const diffInMinutes = Math.floor(
    (slotTime.getTime() - now.getTime()) / 60000,
  );
  const isJoinable = !isTentative && diffInMinutes <= 10 && diffInMinutes >= 0;
  const status = getEventStatus(event);

  const handleJoinMeeting = (e: React.MouseEvent) => {
    e.stopPropagation();
    console.log("Joining meeting:", {
      id: event.id,
      title: getEventTitle(event),
      type: event.type,
    });
  };

  const handleClick = () => {
    if (!isJoinable) {
      console.log("SlotCard clicked:", {
        id: event.id,
        title: getEventTitle(event),
        type: event.type,
        status,
        consultant: getConsultantName(event),
        time: slotTime,
        isTentative,
      });
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.1 }}
      className="group h-full"
    >
      <div onClick={handleClick} className="w-full text-left cursor-pointer">
        <Card className="hover:shadow-md transition-shadow duration-200 border border-gray-100 h-full">
          <CardHeader className="p-6">
            <div className="flex items-start justify-between">
              <div>
                <CardTitle className="text-lg font-semibold">
                  {getEventTitle(event)}
                </CardTitle>
                <div className="flex items-center mt-3">
                  <Avatar className="h-6 w-6 mr-2">
                    <AvatarImage
                      src={getConsultantImage(event) ?? "/placeholder.svg"}
                      alt="Consultant"
                    />
                    <AvatarFallback>
                      {getConsultantInitial(event)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="text-sm text-gray-600">
                    {getConsultantName(event)}
                  </span>
                </div>
              </div>
              <div className="flex flex-col items-end gap-2">
                <Badge className={getStatusColor(status)}>
                  {status}
                  {isTentative && <span className="ml-1 text-red-500">*</span>}
                </Badge>
                <Badge
                  className={`${
                    isJoinable
                      ? "bg-green-100 text-green-800 animate-pulse"
                      : "bg-blue-100 text-blue-800"
                  } text-sm font-medium`}
                >
                  {isJoinable
                    ? "Starting Soon!"
                    : formatTimeUntil(diffInMinutes)}
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-6 pt-0">
            <div className="flex flex-col space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-600">
                  {slotTime.toLocaleString(undefined, {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                <span className="text-sm font-medium text-gray-500 bg-gray-50 px-2 py-1 rounded">
                  {event.type}
                </span>
              </div>
              {isJoinable && (
                <Button
                  onClick={handleJoinMeeting}
                  className="w-full mt-2 bg-green-600 hover:bg-green-700 text-white font-semibold animate-pulse"
                >
                  Join Meeting Now
                </Button>
              )}
              {isTentative && (
                <div className="text-xs text-red-500 mt-2">
                  * Subject to change
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </motion.div>
  );
}

function MonthlyEventCard({
  event,
  slots,
}: Readonly<{
  event: EventWithType;
  slots: SlotWithStatus[];
}>) {
  const status = getEventStatus(event);

  const handleClick = () => {
    console.log("MonthlyEventCard clicked:", {
      id: event.id,
      title: getEventTitle(event),
      type: event.type,
      status,
      consultant: getConsultantName(event),
      slots,
    });
  };

  return (
    <div onClick={handleClick} className="w-full text-left cursor-pointer">
      <Card className="hover:shadow-md transition-shadow duration-200">
        <CardHeader className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg font-semibold">
                {getEventTitle(event)}
              </CardTitle>
              <div className="flex items-center mt-3">
                <Avatar className="h-6 w-6 mr-2">
                  <AvatarImage
                    src={getConsultantImage(event) ?? "/placeholder.svg"}
                    alt="Consultant"
                  />
                  <AvatarFallback>{getConsultantInitial(event)}</AvatarFallback>
                </Avatar>
                <span className="text-sm text-gray-600">
                  {getConsultantName(event)}
                </span>
              </div>
            </div>
            <div className="flex flex-col items-end gap-2">
              <Badge
                className={`${
                  event.type === "Subscription"
                    ? "bg-purple-100 text-purple-800"
                    : "bg-indigo-100 text-indigo-800"
                }`}
              >
                {event.type}
              </Badge>
              <Badge className={getStatusColor(status)}>{status}</Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-6 pt-0">
          <div className="space-y-3">
            {slots.map((slot) => (
              <div
                key={slot.date.getTime()}
                className="text-sm text-gray-600 flex justify-between items-center bg-gray-50 p-3 rounded"
              >
                <span>
                  {slot.date.toLocaleString(undefined, {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </span>
                <div className="flex items-center">
                  <span className="font-medium">
                    {slot.date.toLocaleString(undefined, {
                      timeStyle: "short",
                    })}
                  </span>
                  {slot.isTentative && (
                    <span className="ml-1 text-red-500">*</span>
                  )}
                </div>
              </div>
            ))}
            {slots.some((slot) => slot.isTentative) && (
              <div className="text-xs text-red-500 mt-2">
                * Subject to change
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
