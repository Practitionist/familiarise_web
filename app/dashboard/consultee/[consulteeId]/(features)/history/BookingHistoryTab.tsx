"use client";

import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ConsultationWithPlan,
  SubscriptionWithPlan,
  WebinarWithPlan,
  ClassWithPlan,
} from "@/hooks/useEvents";
// Standardized to use useConsulteeEvents for consistent React Query data fetching
// This replaces the previous useEvents hook to ensure all consultee components use the same API endpoint
import { useConsulteeEvents } from "../../hooks/useConsulteeEvents";
import {
  getEventTitle,
  getConsultantName,
  getConsultantImage,
  getConsultantInitial,
} from "../../utils/getMetadata";

type EventWithType =
  | (ConsultationWithPlan & { type: "Consultation" })
  | (SubscriptionWithPlan & { type: "Subscription" })
  | (WebinarWithPlan & { type: "Webinar" })
  | (ClassWithPlan & { type: "Class" });

export default function BookingHistoryTab({
  consulteeId,
}: {
  consulteeId: string;
}) {
  const {
    data: eventsData,
    isLoading,
    error,
  } = useConsulteeEvents(consulteeId);
  const {
    consultations = [],
    subscriptions = [],
    webinars = [],
    classes = [],
  } = eventsData || {};

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-pulse text-gray-500">
          Loading booking history...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-50 text-red-600 rounded-lg">
        Error loading booking history: {error.message}
      </div>
    );
  }

  const allEvents: EventWithType[] = [
    ...consultations.map((c) => ({ ...c, type: "Consultation" as const })),
    ...subscriptions.map((s) => ({ ...s, type: "Subscription" as const })),
    ...webinars.map((w) => ({ ...w, type: "Webinar" as const })),
    ...classes.map((c) => ({ ...c, type: "Class" as const })),
  ].sort((a, b) => {
    const dateA = getBookingDate(a);
    const dateB = getBookingDate(b);
    return dateB && dateA
      ? new Date(dateB).getTime() - new Date(dateA).getTime()
      : 0; // Sort in descending order
  });

  return (
    <div className="min-h-[calc(100vh-200px)] p-6 bg-gray-50">
      <div className="bg-white rounded-xl p-8 shadow-sm border border-gray-100 mb-6">
        <h2 className="text-3xl font-bold text-gray-900">Booking History</h2>
        <p className="mt-2 text-gray-600">
          View all your past and upcoming sessions
        </p>
      </div>

      <Card className="bg-white shadow-sm border border-gray-100">
        <CardHeader className="p-6">
          <CardTitle className="text-xl font-semibold">
            Your Learning Journey
          </CardTitle>
        </CardHeader>
        <CardContent className="p-6 pt-0">
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="bg-gray-50">
                  <TableHead className="font-semibold">Booking Date</TableHead>
                  <TableHead className="font-semibold">Payment Date</TableHead>
                  <TableHead className="font-semibold">
                    Payment Amount
                  </TableHead>
                  <TableHead className="font-semibold">Session</TableHead>
                  <TableHead className="font-semibold">Expert</TableHead>
                  <TableHead className="font-semibold">Status</TableHead>
                  <TableHead className="font-semibold">Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allEvents.map((event) => (
                  <TableRow
                    key={event.id}
                    className="hover:bg-gray-50 transition-colors cursor-pointer"
                  >
                    <TableCell className="font-medium">
                      {formatDate(getBookingDate(event))}
                    </TableCell>
                    <TableCell className="font-medium">
                      {formatDate(getPaymentDate(event))}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">
                          {formatAmount(getPaymentAmount(event))}
                        </span>
                        {getPaymentStatus(event) && (
                          <Badge
                            className={`${
                              getPaymentStatus(event)?.toLowerCase() ===
                              "succeeded"
                                ? "bg-green-100 text-green-800"
                                : getPaymentStatus(event)?.toLowerCase() ===
                                    "failed"
                                  ? "bg-red-100 text-red-800"
                                  : "bg-yellow-100 text-yellow-800"
                            }`}
                          >
                            {getPaymentStatus(event)}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Badge
                          className={`${
                            event.type === "Consultation"
                              ? "bg-blue-100 text-blue-800"
                              : event.type === "Class"
                                ? "bg-purple-100 text-purple-800"
                                : event.type === "Webinar"
                                  ? "bg-green-100 text-green-800"
                                  : "bg-gray-100 text-gray-800"
                          }`}
                        >
                          {event.type}
                        </Badge>
                        <span className="font-medium">
                          {getEventTitle(event)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Avatar className="h-6 w-6">
                          <AvatarImage
                            src={
                              getConsultantImage(event) ?? "/placeholder.svg"
                            }
                            alt="Consultant"
                          />
                          <AvatarFallback>
                            {getConsultantInitial(event)}
                          </AvatarFallback>
                        </Avatar>
                        <span>{getConsultantName(event)}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        className={`${
                          getEventStatus(event).toLowerCase() === "completed"
                            ? "bg-green-100 text-green-800"
                            : getEventStatus(event).toLowerCase() ===
                                "cancelled"
                              ? "bg-red-100 text-red-800"
                              : getEventStatus(event).toLowerCase() ===
                                  "pending"
                                ? "bg-yellow-100 text-yellow-800"
                                : "bg-gray-100 text-gray-800"
                        }`}
                      >
                        {getEventStatus(event)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-gray-600">
                      {getEventDetails(event)}
                    </TableCell>
                  </TableRow>
                ))}
                {allEvents.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="text-center py-8 text-gray-500"
                    >
                      No bookings found
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function getEventStatus(event: EventWithType): string {
  switch (event.type) {
    case "Consultation":
      return event.requestStatus;
    case "Subscription":
      return event.requestStatus;
    case "Webinar":
      return event.status;
    case "Class":
      return event.status;
  }
}

function formatDate(date: string | null | undefined): string {
  if (!date) return "Not available";
  return new Date(date).toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getBookingDate(event: EventWithType): string | null {
  switch (event.type) {
    case "Consultation":
    case "Webinar":
      return event.appointment?.createdAt
        ? new Date(event.appointment.createdAt).toISOString()
        : null;
    case "Subscription":
    case "Class":
      return event.appointments?.[0]?.createdAt
        ? new Date(event.appointments[0].createdAt).toISOString()
        : null;
  }
}

function formatAmount(amount: number | null): string {
  if (amount === null) return "Not available";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount / 100); // Convert cents to dollars
}

function getPaymentStatus(event: EventWithType): string | null {
  switch (event.type) {
    case "Consultation":
    case "Webinar":
      return event.appointment?.payment?.[0]?.paymentStatus ?? null;
    case "Subscription":
    case "Class":
      return event.appointments?.[0]?.payment?.[0]?.paymentStatus ?? null;
  }
}

function getPaymentAmount(event: EventWithType): number | null {
  switch (event.type) {
    case "Consultation":
    case "Webinar":
      return event.appointment?.payment?.[0]?.amount ?? null;
    case "Subscription":
    case "Class":
      return event.appointments?.[0]?.payment?.[0]?.amount ?? null;
  }
}

function getPaymentDate(event: EventWithType): string | null {
  switch (event.type) {
    case "Consultation":
    case "Webinar":
      return event.appointment?.payment?.[0]?.createdAt
        ? new Date(event.appointment.payment[0].createdAt).toISOString()
        : null;
    case "Subscription":
    case "Class":
      return event.appointments?.[0]?.payment?.[0]?.createdAt
        ? new Date(event.appointments[0].payment[0].createdAt).toISOString()
        : null;
  }
}

function getEventDetails(event: EventWithType): string {
  switch (event.type) {
    case "Consultation":
      return `${event.consultationPlan.title} (${event.consultationPlan.durationInHours} hours)`;
    case "Subscription":
      return `${event.subscriptionPlan.title}`;
    case "Webinar":
      return `${event.webinarPlan.title} (${event.webinarPlan.durationInHours} hours)`;
    case "Class":
      return `${event.classPlan.title}`;
    default:
      return "Unknown";
  }
}
