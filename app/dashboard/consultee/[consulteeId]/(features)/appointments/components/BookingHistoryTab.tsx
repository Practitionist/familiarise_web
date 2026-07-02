"use client";

import React from "react";
import { Building2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import {
  appointmentStatusBadge,
  eventStatusBadge,
  trialStatusBadge,
  resolveSponsoringOrgName,
} from "@/lib/labels/session-labels";
import {
  TConsultationWithPlan,
  TSubscriptionWithPlan,
  TWebinarWithPlan,
  TClassWithPlan,
  TTrialWithPlan,
} from "@/hooks/useEvents";
import {
  getEventTitle,
  getConsultantName,
  getConsultantImage,
} from "../../../utils/getMetadata";
import { useSession } from "@/lib/auth-client";

type EventWithType =
  | (TConsultationWithPlan & { type: "Consultation" })
  | (TSubscriptionWithPlan & { type: "Subscription" })
  | (TWebinarWithPlan & { type: "Webinar" })
  | (TClassWithPlan & { type: "Class" })
  | (TTrialWithPlan & { type: "Trial" });

interface BookingHistoryTabProps {
  consultations: TConsultationWithPlan[];
  subscriptions: TSubscriptionWithPlan[];
  webinars: TWebinarWithPlan[];
  classes: TClassWithPlan[];
  trials: TTrialWithPlan[];
}

// Trials aren't covered by utils/getMetadata (its union predates them), so
// the row helpers branch on Trial locally before delegating.
function getRowTitle(event: EventWithType): string {
  if (event.type === "Trial") return event.subscriptionPlan.title;
  return getEventTitle(event);
}

function getRowConsultantName(event: EventWithType): string {
  if (event.type === "Trial") {
    return (
      event.subscriptionPlan.consultantProfile?.user?.name ??
      "Unknown Consultant"
    );
  }
  return getConsultantName(event);
}

function getRowConsultantImage(event: EventWithType): string | null {
  if (event.type === "Trial") {
    return event.subscriptionPlan.consultantProfile?.user?.image ?? null;
  }
  return getConsultantImage(event);
}

// Extract the org-funding marker from any event variant. Single-appointment
// events (Consultation, Webinar, Trial) carry it directly; multi-appointment
// events (Subscription, Class) take it from the first appointment — all
// child appointments share the same org context per the checkout flow.
function getEventOrganizationId(event: EventWithType): string | null {
  if (
    event.type === "Consultation" ||
    event.type === "Webinar" ||
    event.type === "Trial"
  ) {
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

function getEventStatusBadge(event: EventWithType) {
  switch (event.type) {
    case "Trial":
      return trialStatusBadge(event.status);
    case "Webinar":
    case "Class":
      return eventStatusBadge(event.status);
    default:
      return appointmentStatusBadge(event.status);
  }
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
    case "Trial":
      return event.requestedAt
        ? new Date(event.requestedAt).toISOString()
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
    case "Trial":
      return `${event.subscriptionPlan.title} (free trial · ${event.subscriptionPlan.freeTrialDurationMinutes} min)`;
    default:
      return "Unknown";
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

export function BookingHistoryTab({
  consultations = [],
  subscriptions = [],
  webinars = [],
  classes = [],
  trials = [],
}: BookingHistoryTabProps) {
  const { data: session } = useSession();
  const orgMemberships = session?.user?.organizationMemberships ?? [];

  const allEvents: EventWithType[] = [
    ...consultations.map((c) => ({ ...c, type: "Consultation" as const })),
    ...subscriptions.map((s) => ({ ...s, type: "Subscription" as const })),
    ...webinars.map((w) => ({ ...w, type: "Webinar" as const })),
    ...classes.map((c) => ({ ...c, type: "Class" as const })),
    ...trials.map((t) => ({ ...t, type: "Trial" as const })),
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
          <span className="font-medium">{getRowTitle(event)}</span>
          {(() => {
            const sponsoringOrgName = resolveSponsoringOrgName(
              getEventOrganizationId(event),
              orgMemberships,
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
              src={getRowConsultantImage(event) ?? "/placeholder.svg"}
              alt="Consultant"
            />
            <AvatarFallback>
              {getRowConsultantName(event).charAt(0) || "?"}
            </AvatarFallback>
          </Avatar>
          <span>{getRowConsultantName(event)}</span>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (event) => <StatusBadge {...getEventStatusBadge(event)} size="sm" />,
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
    <Card className="bg-card shadow-sm border border-border">
      <CardHeader className="p-6">
        <CardTitle className="text-xl font-semibold">Booking History</CardTitle>
        <CardDescription>
          All your past and upcoming sessions, including free trials
        </CardDescription>
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
  );
}
