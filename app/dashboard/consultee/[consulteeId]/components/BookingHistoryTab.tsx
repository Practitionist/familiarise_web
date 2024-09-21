"use client"

import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useEvents } from '@/hooks/useEvents';
import { Consultation, Subscription, Webinar, Class } from '@prisma/client';

type EventWithType = 
  | (Consultation & { type: 'Consultation' })
  | (Subscription & { type: 'Subscription' })
  | (Webinar & { type: 'Webinar' })
  | (Class & { type: 'Class' })

export default function BookingHistoryTab({ consulteeId }: { consulteeId: string }) {
  const { consultations, subscriptions, webinars, classes, isLoading, error } = useEvents(consulteeId);

  if (isLoading) {
    return <div>Loading booking history...</div>;
  }

  if (error) {
    return <div>Error loading booking history: {error.message}</div>;
  }

  const allEvents: EventWithType[] = [
    ...consultations.map(c => ({ ...c, type: 'Consultation' as const })),
    ...subscriptions.map(s => ({ ...s, type: 'Subscription' as const })),
    ...webinars.map(w => ({ ...w, type: 'Webinar' as const })),
    ...classes.map(c => ({ ...c, type: 'Class' as const }))
  ].sort((a, b) => {
    const dateA = getEventDate(a);
    const dateB = getEventDate(b);
    return new Date(dateB).getTime() - new Date(dateA).getTime(); // Sort in descending order
  });

  console.log(allEvents);

  return (
    <div className="min-h-[calc(100vh-200px)] space-y-6 overflow-y-auto">
      <h2 className="text-3xl font-bold mb-6">Booking History</h2>
      
      <Card className="bg-white">
        <CardHeader>
          <CardTitle>Your Past and Upcoming Bookings</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {allEvents.map((event) => (
                <TableRow key={event.id} className="bg-white">
                  <TableCell>{new Date(getEventDate(event)).toLocaleDateString()}</TableCell>
                  <TableCell>{event.type}</TableCell>
                  <TableCell>{getEventStatus(event)}</TableCell>
                  <TableCell>{getEventDetails(event)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function getEventDate(event: EventWithType): string {
  switch (event.type) {
    case 'Consultation':
      return event.preferredDateTime ? new Date(event.preferredDateTime).toISOString() : "Unknown";
    case 'Subscription':
      return event.startDate ? new Date(event.startDate).toISOString() : "Unknown";
    case 'Webinar':
      return event.scheduledAt ? new Date(event.scheduledAt).toISOString() : "Unknown";
    case 'Class':
      return event.startDate ? new Date(event.startDate).toISOString() : "Unknown";
  }
}

function getEventStatus(event: EventWithType): string {
  switch (event.type) {
    case 'Consultation':
      return event.appointmentRequestStatus;
    case 'Subscription':
      return event.appointmentRequestStatus;
    case 'Webinar':
      return event.scheduledAt && new Date(event.scheduledAt) > new Date() ? "Upcoming" : "Completed";
    case 'Class':
      return event.startDate && new Date(event.startDate) > new Date() ? "Upcoming" : "Completed";
  }
}

function getEventDetails(event: EventWithType): string {
  switch (event.type) {
    case 'Consultation':
      return `Consultation Plan: ${event.consultationPlanId ?? "Unknown"}`;
    case 'Subscription':
      return `Subscription Plan: ${event.planId ?? "Unknown"}`;
    case 'Webinar':
      return `${event.title ?? "Unknown"} (${event.durationInHours ?? "Unknown"} hours)`;
    case 'Class':
      return `${event.title ?? "Unknown"}`;
    default:
      return "Unknown";
  }
}