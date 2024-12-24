"use client";

import React, { useState } from "react";
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

// Helper function to get consultee profile ID
const getConsulteeProfileId = (userDetails: User | null): string => {
  if (!userDetails?.consulteeProfileId) {
    throw new Error("Consultee profile ID not found");
  }
  return userDetails.consulteeProfileId;
};

type EventWithType =
  | (ConsultationWithPlan & { type: "Consultation" })
  | (SubscriptionWithPlan & { type: "Subscription" })
  | (WebinarWithPlan & { type: "Webinar" })
  | (ClassWithPlan & { type: "Class" });

export default function HomeTab({ userDetails, consulteeId }: HomeTabProps) {
  const consulteeProfileId = getConsulteeProfileId(userDetails);
  const { consultations, subscriptions, webinars, classes, isLoading, error } =
    useEvents(consulteeProfileId);
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

  // Combine all event types into a single array and sort by date
  const allEvents: EventWithType[] = [
    ...consultations.map((c) => ({ ...c, type: "Consultation" as const })),
    ...subscriptions.map((s) => ({ ...s, type: "Subscription" as const })),
    ...webinars.map((w) => ({ ...w, type: "Webinar" as const })),
    ...classes.map((c) => ({ ...c, type: "Class" as const })),
  ].sort(
    (a, b) =>
      new Date(getEventDate(a)).getTime() - new Date(getEventDate(b)).getTime(),
  );

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

  return (
    <div className="space-y-8 min-h-[calc(100vh-200px)] p-6 bg-gray-50">
      <h2 className="text-4xl font-bold text-gray-900">
        Welcome, {userDetails.name}
      </h2>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="space-y-8">
          <Card className="w-full rounded-xl shadow-lg bg-white border-0 hover:shadow-xl transition-shadow duration-200">
            <CardHeader>
              <div className="flex items-center space-x-6">
                <Avatar className="h-16 w-16 rounded-full ring-2 ring-primary/10">
                  <AvatarImage
                    src={userDetails.image || "/placeholder.svg"}
                    alt="User avatar"
                  />
                  <AvatarFallback>
                    {userDetails.name?.charAt(0) || "U"}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <CardTitle className="text-xl font-semibold mb-2">
                    {userDetails.name}
                  </CardTitle>
                  <div className="text-sm text-gray-600 space-y-1">
                    <p className="font-medium">{userDetails.email}</p>
                    <p className="flex items-center">
                      <span className="inline-block w-2 h-2 rounded-full bg-green-400 mr-2"></span>
                      {userDetails.currentTimezone || "Not provided"}
                    </p>
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="mt-6 space-y-4">
                <h3 className="font-semibold text-lg text-gray-900">
                  About Me
                </h3>
                <p className="text-gray-600 text-sm">{"No bio provided yet"}</p>
                <div className="pt-4 border-t border-gray-100">
                  <h4 className="text-sm font-medium text-gray-900 mb-2">
                    Quick Stats
                  </h4>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 sm:gap-4">
                    <div className="bg-gray-50 p-2 sm:p-3 rounded-lg">
                      <p className="text-lg sm:text-2xl font-bold text-primary">
                        {consultations.length}
                      </p>
                      <p className="text-[10px] sm:text-xs text-gray-600">
                        Consultations
                      </p>
                    </div>
                    <div className="bg-gray-50 p-2 sm:p-3 rounded-lg">
                      <p className="text-lg sm:text-2xl font-bold text-primary">
                        {subscriptions.length}
                      </p>
                      <p className="text-[10px] sm:text-xs text-gray-600">
                        Subscriptions
                      </p>
                    </div>
                    <div className="bg-gray-50 p-2 sm:p-3 rounded-lg">
                      <p className="text-lg sm:text-2xl font-bold text-primary">
                        {classes.length}
                      </p>
                      <p className="text-[10px] sm:text-xs text-gray-600">
                        Classes
                      </p>
                    </div>
                    <div className="bg-gray-50 p-2 sm:p-3 rounded-lg">
                      <p className="text-lg sm:text-2xl font-bold text-primary">
                        {webinars.length}
                      </p>
                      <p className="text-[10px] sm:text-xs text-gray-600">
                        Webinars
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <div>
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
              <h2 className="text-2xl font-semibold text-gray-900">
                Monthly Events
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
        </div>

        <div>
          <Card className="w-full rounded-xl shadow-lg bg-white border-0">
            <CardHeader className="border-b border-gray-100">
              <CardTitle className="text-xl font-semibold">
                Recent Events
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="space-y-4">
                {recentEvents.map((event, index) => (
                  <EventCard key={index} event={event} />
                ))}
                {recentEvents.length === 0 && (
                  <div className="text-center py-8">
                    <p className="text-gray-500">No recent events</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
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
      className="group"
    >
      <Card className="hover:shadow-md transition-shadow duration-200 border border-gray-100">
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between">
            <CardTitle className="text-lg font-semibold">
              {getEventTitle(event)}
            </CardTitle>
            <Badge className={`ml-2 ${getStatusColor(getEventStatus(event))}`}>
              {getEventStatus(event)}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
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
