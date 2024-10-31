"use client"

import React, { useState } from 'react';
import { ArrowLeftIcon, ArrowRightIcon } from "@/assets/icons";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useEvents, ConsultationWithPlan, SubscriptionWithPlan, WebinarWithPlan, ClassWithPlan } from '@/hooks/useEvents';
import { User } from '@prisma/client';
import { motion } from "framer-motion";

interface HomeTabProps {
  userDetails: User | null;
  consulteeId: string;
}

type EventWithType = 
  | (ConsultationWithPlan & { type: 'Consultation' })
  | (SubscriptionWithPlan & { type: 'Subscription' })
  | (WebinarWithPlan & { type: 'Webinar' })
  | (ClassWithPlan & { type: 'Class' });

export default function HomeTab({ userDetails, consulteeId }: HomeTabProps) {
  const { consultations, subscriptions, webinars, classes, isLoading, error } = useEvents(consulteeId);
  const [currentMonth, setCurrentMonth] = useState(new Date());

  if (!userDetails || isLoading) {
    return <div>Loading user data...</div>;
  }

  if (error) {
    return <div>Error loading events: {error.message}</div>;
  }

  // Combine all event types into a single array and sort by date
  const allEvents: EventWithType[] = [
    ...consultations.map(c => ({ ...c, type: 'Consultation' as const })),
    ...subscriptions.map(s => ({ ...s, type: 'Subscription' as const })),
    ...webinars.map(w => ({ ...w, type: 'Webinar' as const })),
    ...classes.map(c => ({ ...c, type: 'Class' as const }))
  ].sort((a, b) => new Date(getEventDate(a)).getTime() - new Date(getEventDate(b)).getTime());

  // Filter events for the current month
  const eventsForCurrentMonth = allEvents.filter(event => {
    const eventDate = new Date(getEventDate(event));
    return eventDate.getMonth() === currentMonth.getMonth() && eventDate.getFullYear() === currentMonth.getFullYear();
  });

  // Calculate the date one week ago
  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  
  // Filter events that occurred within the last week
  const recentEvents = allEvents.filter(event => new Date(getEventDate(event)) >= oneWeekAgo);

  // Function to navigate to the previous month
  const goToPreviousMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1));
  };

  // Function to navigate to the next month
  const goToNextMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1));
  };

  return (
    <div className="space-y-6 min-h-[calc(100vh-200px)]">
      <h2 className="text-3xl font-bold">Welcome, {userDetails.name}</h2>
      <div className="grid grid-cols-2 gap-8">
        <div>
          <Card className="w-full mb-6 rounded-lg shadow-lg bg-white">
            <CardHeader>
              <div className="flex items-center space-x-4">
                <Avatar className="rounded-full">
                  <AvatarImage src={userDetails.image || "/placeholder.svg"} alt="User avatar" />
                  <AvatarFallback>{userDetails.name?.charAt(0) || 'U'}</AvatarFallback>
                </Avatar>
                <div>
                  <CardTitle className="text-xl font-semibold">{userDetails.name}</CardTitle>
                  <div className="text-sm text-gray-500">
                    <p>{userDetails.name}</p>
                    <p>Timezone: {userDetails.currentTimezone || 'Not provided'}</p>
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="mt-4">
                <h3 className="font-semibold">About Me</h3>
              </div>
            </CardContent>
          </Card>
          <div>
            <div className="flex justify-between items-center mb-2">
              <h2 className="text-xl font-semibold">Monthly Events</h2>
              <div className="flex items-center space-x-2">
                <Button onClick={goToPreviousMonth} variant="outline" size="icon">
                  <ArrowLeftIcon className="h-4 w-4" />
                </Button>
                <p className="text-sm text-gray-500">{currentMonth.toLocaleString('default', { month: 'long', year: 'numeric' })}</p>
                <Button onClick={goToNextMonth} variant="outline" size="icon">
                  <ArrowRightIcon className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="space-y-4">
              {eventsForCurrentMonth.map((event, index) => (
                <EventCard key={index} event={event} />
              ))}
              {eventsForCurrentMonth.length === 0 && (
                <p className="text-center text-gray-500">No events for this month</p>
              )}
            </div>
          </div>
        </div>
        <div>
          <Card className="w-full mb-6 rounded-lg shadow-lg bg-white">
            <CardHeader>
              <CardTitle className="text-xl font-semibold">Recent Events</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {recentEvents.map((event, index) => (
                  <EventCard key={index} event={event} />
                ))}
                {recentEvents.length === 0 && (
                  <p className="text-center text-gray-500">No recent events</p>
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
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.1 }}
    >
      <Card>
        <CardHeader>
          <CardTitle className="text-lg font-semibold">{getEventTitle(event)}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-muted-foreground">{new Date(getEventDate(event)).toLocaleString()}</div>
            </div>
            <Badge variant={getEventStatus(event).toLowerCase().includes("not") ? "secondary" : "outline"}>
              {getEventStatus(event)}
            </Badge>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  )
}

function getEventDate(event: EventWithType): string {
  switch (event.type) {
    case 'Consultation':
      return event.preferredDateTime?.toString() || "Unknown";
    case 'Subscription':
      return event.startDate?.toString() || "Unknown";
    case 'Webinar':
      return event.scheduledAt?.toString() || "Unknown";
    case 'Class':
      return event.startDate?.toString() || "Unknown";
  }
}

function getEventStatus(event: EventWithType): string {
  switch (event.type) {
    case 'Consultation':
    case 'Subscription':
      return event.requestStatus;
    case 'Webinar':
      return event.status;
    case 'Class':
      return event.status;
  }
}

function getEventTitle(event: EventWithType): string {
  switch (event.type) {
    case 'Consultation':
      return event.consultationPlan.title;
    case 'Subscription':
      return event.plan.title;
    case 'Webinar':
      return event.webinarPlan.title;
    case 'Class':
      return event.classPlan.title;
  }
}
