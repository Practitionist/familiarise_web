"use client";

import React from "react";
import { Building2 } from "lucide-react";
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
  TConsultationWithPlan,
  TSubscriptionWithPlan,
  TWebinarWithPlan,
  TClassWithPlan,
} from "@/hooks/useEvents";
import {
  getEventTitle,
  getConsultantName,
  getConsultantImage,
  getConsultantInitial,
} from "../../utils/getMetadata";
import { useSession } from "@/lib/auth-client";

type EventWithType =
  | (TConsultationWithPlan & { type: "Consultation" })
  | (TSubscriptionWithPlan & { type: "Subscription" })
  | (TWebinarWithPlan & { type: "Webinar" })
  | (TClassWithPlan & { type: "Class" });

// Updated to receive data as props instead of fetching internally
interface BookingHistoryTabProps {
  consultations: TConsultationWithPlan[];
  subscriptions: TSubscriptionWithPlan[];
  webinars: TWebinarWithPlan[];
  classes: TClassWithPlan[];
}

// Extract the org-funding marker from any event variant. Single-appointment
// events (Consultation, Webinar) carry it directly; multi-appointment
// events (Subscription, Class) take it from the first appointment — all
// child appointments share the same org context per the checkout flow.
function getEventOrganizationId(event: EventWithType): string | null {
  if (event.type === "Consultation" || event.type === "Webinar") {
    return event.appointment?.organizationId ?? null;
  }
  if (event.type === "Subscription") {
    return event.appointments?.[0]?.organizationId ?? null;
  }
  if (event.type === "Class") {
    return event.appointment?.[0]?.organizationId ?? null;
  }
  return null;
}

export function BookingHistoryTab({
  consultations = [],
  subscriptions = [],
  webinars = [],
  classes = [],
}: BookingHistoryTabProps) {
  const { data: session } = useSession();
  const orgMemberships = session?.user?.organizationMemberships ?? [];
  const resolveSponsoringOrgName = (
    orgId: string | null | undefined,
  ): string | null => {
    if (!orgId) return null;
    return (
      orgMemberships.find((m) => m.organizationId === orgId)?.organizationName ??
      "the organization"
    );
  };

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
                  <TableHead className="font-semibold">Date</TableHead>
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
                    <TableCell>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge className="text-xs font-medium bg-transparent border border-zinc-300 text-zinc-600 rounded-md">
                          {event.type}
                        </Badge>
                        <span className="font-medium">
                          {getEventTitle(event)}
                        </span>
                        {(() => {
                          const sponsoringOrgName = resolveSponsoringOrgName(
                            getEventOrganizationId(event),
                          );
                          return sponsoringOrgName ? (
                            <Badge
                              className="text-[10px] font-semibold px-2 py-0.5 bg-indigo-50 text-indigo-700 border-0 rounded-md inline-flex items-center gap-1 max-w-[200px]"
                              title={`Sponsored by ${sponsoringOrgName}`}
                            >
                              <Building2 className="h-3 w-3 shrink-0" />
                              <span className="truncate">
                                Sponsored · {sponsoringOrgName}
                              </span>
                            </Badge>
                          ) : null;
                        })()}
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
                        className={`text-xs font-medium ${getStatusStyle(getEventStatus(event))}`}
                      >
                        {getEventStatus(event).replace(/_/g, " ")}
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
                      colSpan={5}
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

// Status styling - refined professional colors
function getStatusStyle(status: string): string {
  const statusUpper = status?.toUpperCase();
  switch (statusUpper) {
    case "APPROVED":
      return "bg-teal-50 text-teal-600";
    case "PENDING":
      return "bg-orange-50 text-orange-600";
    case "SCHEDULED":
      return "bg-indigo-50 text-indigo-600";
    case "IN_PROGRESS":
      return "bg-cyan-50 text-cyan-600";
    case "COMPLETED":
      return "bg-slate-100 text-slate-500";
    case "CANCELLED":
      return "bg-stone-100 text-stone-400";
    case "REJECTED":
      return "bg-red-50 text-red-600";
    default:
      return "bg-slate-100 text-slate-500";
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
