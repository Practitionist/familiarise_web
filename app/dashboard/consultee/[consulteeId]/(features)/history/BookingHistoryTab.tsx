"use client";

import React from "react";
import { Building2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { PageHeader } from "@/components/ui/page-header";
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

  const columns: ResponsiveColumn<EventWithType>[] = [
    {
      key: "date",
      header: "Date",
      cell: (event) => (
        <span className="font-medium">{formatDate(getBookingDate(event))}</span>
      ),
    },
    {
      key: "session",
      header: "Session",
      primary: true,
      cell: (event) => (
        <div className="flex items-center gap-2 flex-wrap">
          <Badge className="text-xs font-medium bg-transparent border border-border text-muted-foreground rounded-md">
            {event.type}
          </Badge>
          <span className="font-medium">{getEventTitle(event)}</span>
          {(() => {
            const sponsoringOrgName = resolveSponsoringOrgName(
              getEventOrganizationId(event),
            );
            return sponsoringOrgName ? (
              <Badge
                className="text-[10px] font-semibold px-2 py-0.5 bg-muted text-muted-foreground border-0 rounded-md inline-flex items-center gap-1 max-w-[200px]"
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
      ),
    },
    {
      key: "expert",
      header: "Expert",
      cell: (event) => (
        <div className="flex items-center gap-2">
          <Avatar className="h-6 w-6">
            <AvatarImage
              src={getConsultantImage(event) ?? "/placeholder.svg"}
              alt="Consultant"
            />
            <AvatarFallback>{getConsultantInitial(event)}</AvatarFallback>
          </Avatar>
          <span>{getConsultantName(event)}</span>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (event) => (
        <Badge
          className={`text-xs font-medium ${getStatusStyle(getEventStatus(event))}`}
        >
          {getEventStatus(event).replace(/_/g, " ")}
        </Badge>
      ),
    },
    {
      key: "details",
      header: "Details",
      className: "text-muted-foreground",
      cell: (event) => getEventDetails(event),
    },
  ];

  const emptyState = (
    <div className="text-center py-8 text-muted-foreground">
      No bookings found
    </div>
  );

  return (
    <div className="min-h-[calc(100vh-200px)] p-6 bg-muted">
      <div className="bg-card rounded-xl p-8 shadow-sm border border-border mb-6">
        <PageHeader
          title="Booking History"
          description="View all your past and upcoming sessions"
        />
      </div>

      <Card className="bg-card shadow-sm border border-border">
        <CardHeader className="p-6">
          <CardTitle className="text-xl font-semibold">
            Your Learning Journey
          </CardTitle>
        </CardHeader>
        <CardContent className="p-6 pt-0">
          <ResponsiveTable<EventWithType>
            columns={columns}
            rows={allEvents}
            getRowId={(e) => e.id}
            empty={emptyState}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function getEventStatus(event: EventWithType): string {
  switch (event.type) {
    case "Consultation":
      return event.status;
    case "Subscription":
      return event.status;
    case "Webinar":
      return event.status;
    case "Class":
      return event.status;
  }
}

// Status styling - semantic status colors kept; off-brand indigo/cyan accents
// (SCHEDULED/IN_PROGRESS) collapsed to neutral monochrome.
function getStatusStyle(status: string): string {
  const statusUpper = status?.toUpperCase();
  switch (statusUpper) {
    case "APPROVED":
      return "bg-teal-50 text-teal-600 dark:bg-teal-900/30 dark:text-teal-300";
    case "PENDING":
      return "bg-orange-50 text-orange-600 dark:bg-orange-900/30 dark:text-orange-300";
    case "SCHEDULED":
      return "bg-muted text-foreground";
    case "IN_PROGRESS":
      return "bg-muted text-foreground";
    case "COMPLETED":
      return "bg-muted text-muted-foreground";
    case "CANCELLED":
      return "bg-muted text-muted-foreground/70";
    case "REJECTED":
      return "bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-300";
    default:
      return "bg-muted text-muted-foreground";
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
