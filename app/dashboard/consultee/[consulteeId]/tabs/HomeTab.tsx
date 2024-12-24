"use client";

import React, { useState, useRef } from "react";
import { ArrowLeftIcon, ArrowRightIcon } from "@/assets/icons";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  useEvents,
  ConsultationWithPlan,
  SubscriptionWithPlan,
  WebinarWithPlan,
  ClassWithPlan,
} from "@/hooks/useEvents";
import { User } from "@prisma/client";
import { motion } from "framer-motion";

interface HomeTabProps {
  userDetails: User | null;
  consulteeId: string;
}

type EventWithType =
  | (ConsultationWithPlan & { type: "Consultation" })
  | (SubscriptionWithPlan & { type: "Subscription" })
  | (WebinarWithPlan & { type: "Webinar" })
  | (ClassWithPlan & { type: "Class" });

export default function HomeTab({ userDetails, consulteeId }: HomeTabProps) {
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

  // Combine all event types into a single array and sort by date
  const allEvents: EventWithType[] = [
    ...consultations.map((c) => ({ ...c, type: "Consultation" as const })),
    ...subscriptions.map((s) => ({ ...s, type: "Subscription" as const })),
    ...webinars.map((w) => ({ ...w, type: "Webinar" as const })),
    ...classes.map((c) => ({ ...c, type: "Class" as const })),
  ].sort((a, b) => {
    const getEventTime = (event: EventWithType) => {
      switch (event.type) {
        case "Consultation":
        case "Subscription":
          return event.requestedAt;
        case "Webinar":
          return event.scheduledAt;
        case "Class":
          return event.startDate || event.createdAt;
      }
    };

    const timeA = getEventTime(a);
    const timeB = getEventTime(b);

    return new Date(timeB).getTime() - new Date(timeA).getTime();
  });

  // Filter events for the current month
  const eventsForCurrentMonth = allEvents.filter((event) => {
    const eventDate = new Date(getEventDate(event));
    return (
      eventDate.getMonth() === currentMonth.getMonth() &&
      eventDate.getFullYear() === currentMonth.getFullYear()
    );
  });

  // Calculate the date one week ago
  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

  // Filter events that occurred within the last week
  const recentEvents = allEvents.filter(
    (event) => new Date(getEventDate(event)) >= oneWeekAgo,
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

  return (
    <div className="space-y-8 min-h-[calc(100vh-200px)] p-6 bg-gray-50">
      <h2 className="text-4xl font-bold text-gray-900">
        Welcome, {userDetails.name}
      </h2>

      {/* Top Row - Recent Events Carousel */}
      <div className="relative">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-2xl font-semibold">Recent Events</h2>
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
          {recentEvents.map((event, index) => (
            <div key={index} className="flex-none w-[300px]">
              <EventCard event={event} />
            </div>
          ))}
          {recentEvents.length === 0 && (
            <div className="w-full text-center py-8">
              <p className="text-gray-500">No recent events</p>
            </div>
          )}
        </div>
      </div>

      {/* Bottom Row - Upcoming Events and Advertisement */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Upcoming Events */}
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
              <EventCard key={index} event={event} />
            ))}
            {eventsForCurrentMonth.length === 0 && (
              <div className="text-center py-8 bg-white rounded-lg border border-dashed border-gray-200">
                <p className="text-gray-500">No events for this month</p>
              </div>
            )}
          </div>
        </div>

        {/* Advertisement Card */}
        <Card className="rounded-xl shadow-lg bg-white border-0 overflow-hidden">
          <CardContent className="p-0">
            <div className="relative aspect-[4/3] w-full">
              <img
                src="/placeholder.svg"
                alt="Advertisement"
                className="object-cover w-full h-full"
              />
              <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black/60 to-transparent text-white">
                <h3 className="text-2xl font-bold mb-2">
                  Upgrade Your Experience
                </h3>
                <p className="mb-4">
                  Get access to premium features and exclusive content
                </p>
                <Button className="bg-white text-black hover:bg-gray-100">
                  Learn More
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function EventCard({ event }: { event: EventWithType }) {
  const getStatusColor = (status: string) => {
    const statusLower = status.toLowerCase();
    if (statusLower === "completed")
      return "bg-green-50 text-green-700 border-green-200";
    if (statusLower === "rejected")
      return "bg-red-50 text-red-700 border-red-200";
    if (statusLower === "pending")
      return "bg-yellow-50 text-yellow-700 border-yellow-200";
    return "bg-gray-50 text-gray-700 border-gray-200";
  };

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
            <Badge className={`ml-2 ${getStatusColor(getEventStatus(event))}`}>
              {getEventStatus(event)}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <span className="text-sm text-gray-600">
                  {new Date(getEventDate(event)).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </span>
              </div>
              <span className="text-sm font-medium text-gray-500 bg-gray-50 px-2 py-1 rounded">
                {event.type}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

function getEventDate(event: EventWithType): string {
  switch (event.type) {
    case "Consultation":
      return event.preferredDateTime?.toString() || "Unknown";
    case "Subscription":
      return event.startDate?.toString() || "Unknown";
    case "Webinar":
      return event.scheduledAt?.toString() || "Unknown";
    case "Class":
      return event.startDate?.toString() || "Unknown";
  }
}

function getEventStatus(event: EventWithType): string {
  switch (event.type) {
    case "Consultation":
    case "Subscription":
      return event.requestStatus;
    case "Webinar":
      return event.status;
    case "Class":
      return event.status;
  }
}

function getEventTitle(event: EventWithType): string {
  switch (event.type) {
    case "Consultation":
      return event.consultationPlan.title;
    case "Subscription":
      return event.subscriptionPlan.title;
    case "Webinar":
      return event.webinarPlan.title;
    case "Class":
      return event.classPlan.title;
  }
}

function getConsultantName(event: EventWithType): string {
  switch (event.type) {
    case "Consultation":
      return (
        event.consultationPlan.consultantProfile?.user?.name ||
        "Unknown Consultant"
      );
    case "Subscription":
      return (
        event.subscriptionPlan.consultantProfile?.user?.name ||
        "Unknown Consultant"
      );
    case "Webinar":
      return (
        event.webinarPlan.consultantProfile?.user?.name || "Unknown Consultant"
      );
    case "Class":
      return (
        event.classPlan.consultantProfile?.user?.name || "Unknown Consultant"
      );
  }
}

function getConsultantImage(event: EventWithType): string | null {
  switch (event.type) {
    case "Consultation":
      return event.consultationPlan.consultantProfile?.user?.image || null;
    case "Subscription":
      return event.subscriptionPlan.consultantProfile?.user?.image || null;
    case "Webinar":
      return event.webinarPlan.consultantProfile?.user?.image || null;
    case "Class":
      return event.classPlan.consultantProfile?.user?.image || null;
  }
}

function getConsultantInitial(event: EventWithType): string {
  const name = getConsultantName(event);
  return name.charAt(0) || "?";
}
