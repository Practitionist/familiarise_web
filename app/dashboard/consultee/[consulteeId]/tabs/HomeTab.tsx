"use client";

import React, { useRef, useState } from "react";
import { ArrowLeftIcon, ArrowRightIcon } from "@/assets/icons";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useEvents } from "@/hooks/useEvents";
import { User } from "@prisma/client";
import { motion } from "framer-motion";
import {
  EventWithType,
  formatTimeUntil,
  getEventTitle,
  getConsultantName,
  getConsultantImage,
  getConsultantInitial,
  formatDate,
  isEventJoinable,
  getMonthlyEvents,
  getUpcomingSlots,
} from "../utils";

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
  const [currentMonth, setCurrentMonth] = useState(new Date());
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
  const upcomingSlots = getUpcomingSlots(allEvents);

  // Get monthly grouped events for bottom row
  const monthlyEvents = getMonthlyEvents(allEvents, currentMonth);

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
    <div className="space-y-8 min-h-[calc(100vh-200px)] p-6 bg-gray-50">
      <h2 className="text-4xl font-bold text-gray-900">
        Welcome, {userDetails.name}
      </h2>

      {/* Top Row - Chronological Slots */}
      <div className="relative">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-2xl font-semibold">Upcoming Sessions</h2>
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
          className="flex overflow-x-auto gap-4 pb-4 scrollbar-hide scroll-smooth"
          style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
        >
          {upcomingSlots.map((slot, index) => (
            <div
              key={`${slot.event.id}-${index}`}
              className="flex-none w-[300px]"
            >
              <SlotCard event={slot.event} slotTime={slot.slotTime} />
            </div>
          ))}
          {upcomingSlots.length === 0 && (
            <div className="w-full text-center py-8">
              <p className="text-gray-500">No upcoming sessions</p>
            </div>
          )}
        </div>
      </div>

      {/* Bottom Row - Monthly Events */}
      <div>
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-2xl font-semibold">
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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {monthlyEvents.map(({ event, slots }, index) => (
            <MonthlyEventCard key={index} event={event} slots={slots} />
          ))}
          {monthlyEvents.length === 0 && (
            <div className="col-span-2 text-center py-8 bg-white rounded-lg border border-dashed border-gray-200">
              <p className="text-gray-500">No sessions this month</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SlotCard({
  event,
  slotTime,
}: {
  event: EventWithType;
  slotTime: Date;
}) {
  const now = new Date();
  const diffInMinutes = Math.floor(
    (slotTime.getTime() - now.getTime()) / 60000,
  );
  const isJoinable = diffInMinutes <= 10 && diffInMinutes > -30;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.1 }}
      className="group h-full"
    >
      <Card className="hover:shadow-md transition-shadow duration-200 border border-gray-100 h-full">
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between">
            <div>
              <CardTitle className="text-lg font-semibold">
                {getEventTitle(event)}
              </CardTitle>
              <div className="flex items-center mt-2">
                <Avatar className="h-6 w-6 mr-2">
                  <AvatarImage
                    src={getConsultantImage(event) || "/placeholder.svg"}
                    alt="Consultant"
                  />
                  <AvatarFallback>{getConsultantInitial(event)}</AvatarFallback>
                </Avatar>
                <span className="text-sm text-gray-600">
                  {getConsultantName(event)}
                </span>
              </div>
            </div>
            <Badge
              className={`ml-2 ${
                isJoinable
                  ? "bg-green-100 text-green-800"
                  : "bg-blue-100 text-blue-800"
              }`}
            >
              {isJoinable ? "Join Now" : formatTimeUntil(diffInMinutes)}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col space-y-2">
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
              <Button className="w-full mt-2 bg-green-600 hover:bg-green-700 text-white">
                Join Meeting
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

function MonthlyEventCard({
  event,
  slots,
}: {
  event: EventWithType;
  slots: Date[];
}) {
  return (
    <Card className="hover:shadow-md transition-shadow duration-200">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg font-semibold">
              {getEventTitle(event)}
            </CardTitle>
            <div className="flex items-center mt-2">
              <Avatar className="h-6 w-6 mr-2">
                <AvatarImage
                  src={getConsultantImage(event) || "/placeholder.svg"}
                  alt="Consultant"
                />
                <AvatarFallback>{getConsultantInitial(event)}</AvatarFallback>
              </Avatar>
              <span className="text-sm text-gray-600">
                {getConsultantName(event)}
              </span>
            </div>
          </div>
          <Badge
            className={`${
              event.type === "Subscription"
                ? "bg-purple-100 text-purple-800"
                : "bg-indigo-100 text-indigo-800"
            }`}
          >
            {event.type}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {slots.map((slot, index) => (
            <div
              key={index}
              className="text-sm text-gray-600 flex justify-between items-center"
            >
              <span>
                {slot.toLocaleString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
              <span className="font-medium">
                {slot.toLocaleString(undefined, { timeStyle: "short" })}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
