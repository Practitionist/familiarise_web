"use client"

import { ArrowLeftIcon, ArrowRightIcon } from "@/assets/icons";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useEvents } from '@/hooks/useEvents';
import { Class, Consultation, Subscription, User, Webinar } from '@prisma/client';
import { motion } from "framer-motion";

interface HomeTabProps {
  userDetails: User | null;
  consulteeId: string;
}

type EventType = 
  | (Consultation & { type: 'Consultation' })
  | (Subscription & { type: 'Subscription' })
  | (Webinar & { type: 'Webinar' })
  | (Class & { type: 'Class' });

export default function HomeTab({ userDetails, consulteeId }: HomeTabProps) {
  const { consultations, subscriptions, webinars, classes, isLoading, error } = useEvents(consulteeId);

  if (!userDetails || isLoading) {
    return <div>Loading user data...</div>;
  }

  if (error) {
    return <div>Error loading events: {error.message}</div>;
  }

  const leftColumnEvents: EventType[] = [
    ...consultations.map(c => ({ ...c, type: 'Consultation' as const })),
    ...subscriptions.map(s => ({ ...s, type: 'Subscription' as const }))
  ].sort((a, b) => new Date(getEventDate(a)).getTime() - new Date(getEventDate(b)).getTime());

  const rightColumnEvents: EventType[] = [
    ...webinars.map(w => ({ ...w, type: 'Webinar' as const })),
    ...classes.map(c => ({ ...c, type: 'Class' as const }))
  ].sort((a, b) => new Date(getEventDate(a)).getTime() - new Date(getEventDate(b)).getTime());

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
              <h2 className="text-xl font-semibold">Consultations & Subscriptions</h2>
              <div className="flex items-center space-x-2">
                <ArrowLeftIcon className="h-4 w-4 text-gray-500 hover:text-gray-700 cursor-pointer" />
                <p className="text-sm text-gray-500">{new Date().toLocaleString('default', { month: 'long', year: 'numeric' })}</p>
                <ArrowRightIcon className="h-4 w-4 text-gray-500 hover:text-gray-700 cursor-pointer" />
              </div>
            </div>
            <div className="space-y-4">
              {leftColumnEvents.map((event, index) => (
                <EventCard key={index} event={event} />
              ))}
            </div>
          </div>
        </div>
        <div>
          <Card className="w-full mb-6 rounded-lg shadow-lg bg-white">
            <CardHeader>
              <CardTitle className="text-xl font-semibold">Classes & Webinars</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {rightColumnEvents.map((event, index) => (
                  <EventCard key={index} event={event} />
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function EventCard({ event }: { event: EventType }) {
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

function getEventDate(event: EventType): string {
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

function getEventStatus(event: EventType): string {
  switch (event.type) {
    case 'Consultation':
    case 'Subscription':
      return event.appointmentRequestStatus || "Pending";
    case 'Webinar':
    case 'Class':
      const eventDate = getEventDate(event);
      return new Date(eventDate) > new Date() ? "Upcoming" : "Completed";
  }
}

function getEventTitle(event: EventType): string {
  switch (event.type) {
    case 'Consultation':
      return `Consultation`;
    case 'Subscription':
      return `Subscription`;
    case 'Webinar':
    case 'Class':
      return event.title || event.type;
  }
}