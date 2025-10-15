"use client";

import React from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Edit, Trash2 } from "lucide-react";
import Link from "next/link";
import { ChevronLeftIcon, ChevronRightIcon } from "@radix-ui/react-icons";
import {
  WebinarEvent,
  ClassEvent,
  ConsultationPlanEvent,
  SubscriptionPlanEvent,
  Event,
} from "../types/event";
import { Badge } from "@/components/ui/badge";
import { WebinarStatus, ClassStatus } from "@prisma/client";

interface WebinarCarouselProps {
  events: WebinarEvent[];
  onEdit: (event: WebinarEvent) => void;
  onDelete: (eventId: string) => Promise<void>;
  eventType: "webinar";
  participantCounts: Record<string, number>;
}

interface ClassCarouselProps {
  events: ClassEvent[];
  onEdit: (event: ClassEvent) => void;
  onDelete: (eventId: string) => Promise<void>;
  eventType: "class";
  participantCounts: Record<string, number>;
}

interface ConsultationCarouselProps {
  events: ConsultationPlanEvent[];
  onEdit: (event: ConsultationPlanEvent) => void;
  onDelete: (eventId: string) => Promise<void>;
  eventType: "consultation";
  participantCounts: Record<string, number>;
}

interface SubscriptionCarouselProps {
  events: SubscriptionPlanEvent[];
  onEdit: (event: SubscriptionPlanEvent) => void;
  onDelete: (eventId: string) => Promise<void>;
  eventType: "subscription";
  participantCounts: Record<string, number>;
}

type EventCarouselProps =
  | WebinarCarouselProps
  | ClassCarouselProps
  | ConsultationCarouselProps
  | SubscriptionCarouselProps;

function isWebinarEvent(event: Event): event is WebinarEvent {
  return event.type === "webinar";
}

function isClassEvent(event: Event): event is ClassEvent {
  return event.type === "class";
}

function isConsultationPlanEvent(event: Event): event is ConsultationPlanEvent {
  return event.type === "consultation";
}

function isSubscriptionPlanEvent(event: Event): event is SubscriptionPlanEvent {
  return event.type === "subscription";
}

export function EventCarousel({
  events,
  onEdit,
  onDelete,
  eventType,
  participantCounts,
}: EventCarouselProps) {
  const [currentPage, setCurrentPage] = React.useState(1);
  const itemsPerPage = 8; // Show 8 items per page (adjust as needed)

  // Calculate pagination variables
  const totalPages = Math.ceil(events.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const currentEvents = events.slice(startIndex, endIndex);

  // Pagination handlers
  const goToNextPage = () => {
    setCurrentPage((prev) => Math.min(prev + 1, totalPages));
  };

  const goToPreviousPage = () => {
    setCurrentPage((prev) => Math.max(prev - 1, 1));
  };

  const getEventTitle = (event: Event): string => {
    if (isWebinarEvent(event)) {
      return event.webinarPlan.title;
    }
    if (isClassEvent(event)) {
      return event.classPlan.title;
    }
    if (isConsultationPlanEvent(event)) {
      return event.consultationPlan.title;
    }
    if (isSubscriptionPlanEvent(event)) {
      return event.subscriptionPlan.title;
    }
    throw new Error(`Unknown event type encountered.`);
  };

  const getEventDescription = (event: Event): string => {
    if (isWebinarEvent(event)) {
      return event.webinarPlan.description ?? "";
    }
    if (isClassEvent(event)) {
      return event.classPlan.description ?? "";
    }
    if (isConsultationPlanEvent(event)) {
      return event.consultationPlan.description ?? "";
    }
    if (isSubscriptionPlanEvent(event)) {
      return event.subscriptionPlan.description ?? "";
    }
    throw new Error(`Unknown event type encountered.`);
  };

  const getEventPrice = (event: Event) => {
    if (isWebinarEvent(event)) {
      return event.webinarPlan.price;
    }
    if (isClassEvent(event)) {
      return event.classPlan.price;
    }
    if (isConsultationPlanEvent(event)) {
      return event.consultationPlan.price;
    }
    if (isSubscriptionPlanEvent(event)) {
      return event.subscriptionPlan.price;
    }
    throw new Error(`Unknown event type encountered.`);
  };

  const getEventCurrency = (event: Event): string => {
    if (isWebinarEvent(event)) {
      return event.webinarPlan.priceCurrency ?? "INR"; // Default to INR if null/undefined
    }
    if (isClassEvent(event)) {
      return event.classPlan.priceCurrency ?? "INR"; // Default to INR if null/undefined
    }
    if (isConsultationPlanEvent(event)) {
      return "INR"; // Consultations don't have currency field
    }
    if (isSubscriptionPlanEvent(event)) {
      return "INR"; // Subscriptions don't have currency field
    }
    throw new Error(`Unknown event type encountered.`);
  };

  const getEventDuration = (event: Event) => {
    if (isWebinarEvent(event)) {
      return `${event.webinarPlan.durationInHours} hours`;
    }
    if (isClassEvent(event)) {
      return `${event.classPlan.durationInMonths} months`;
    }
    if (isConsultationPlanEvent(event)) {
      return `${event.consultationPlan.durationInHours} hours`;
    }
    if (isSubscriptionPlanEvent(event)) {
      return `${event.subscriptionPlan.durationInMonths} months`;
    }
    throw new Error(`Unknown event type encountered.`);
  };

  // No longer need local state or useEffect for participant counts
  // Using the pre-fetched participantCounts prop

  const getParticipantsCount = (event: Event) => {
    let maxParticipants = 0;

    if (isWebinarEvent(event)) {
      maxParticipants = event.webinarPlan.maxParticipants;
    } else if (isClassEvent(event)) {
      maxParticipants = event.classPlan.maxParticipants;
    } else if (isConsultationPlanEvent(event)) {
      // Consultations are 1-on-1, so max participants is 1
      maxParticipants = 1;
    } else if (isSubscriptionPlanEvent(event)) {
      // Subscriptions are 1-on-1, so max participants is 1
      maxParticipants = 1;
    }

    return {
      currentParticipants: participantCounts[event.id ?? ""] ?? 0,
      maxParticipants,
    };
  };

  const handleEdit = (event: Event) => {
    if (eventType === "webinar" && isWebinarEvent(event)) {
      onEdit(event);
    } else if (eventType === "class" && isClassEvent(event)) {
      onEdit(event);
    } else if (eventType === "consultation" && isConsultationPlanEvent(event)) {
      onEdit(event);
    } else if (eventType === "subscription" && isSubscriptionPlanEvent(event)) {
      onEdit(event);
    }
  };

  const handleDelete = async (event: Event) => {
    const eventTitle = getEventTitle(event);
    if (
      window.confirm(
        `Are you sure you want to delete "${eventTitle}"? This action cannot be undone.`,
      )
    ) {
      try {
        await onDelete(event.id ?? "");
        // Optionally show a success toast, though parent might handle it
      } catch (error) {
        console.error(`Error deleting ${eventType}:`, error);
        // Optionally show an error toast
      }
    }
  };

  // Helper function for participant display text
  const getParticipantsDisplayText = (current: number, max: number) => {
    return `${current}/${max} participants`;
  };

  const getEventStatus = (event: Event): WebinarStatus | ClassStatus | null => {
    if (isWebinarEvent(event)) {
      return event.status ?? null;
    }
    if (isClassEvent(event)) {
      return event.status ?? null;
    }
    return null;
  };

  const getEventStartDate = (event: Event): Date | null => {
    if (isWebinarEvent(event)) {
      const startTimeString =
        event.appointment?.slotsOfAppointment?.[0]?.startsAt;
      return startTimeString ? new Date(startTimeString) : null;
    }
    if (isClassEvent(event)) {
      return event.schedulingPeriodStartsAt ? new Date(event.schedulingPeriodStartsAt) : null;
    }
    return null;
  };

  const formatDateTime = (date: Date | null): string => {
    if (!date) return "Unscheduled";
    try {
      // Adjust locale and options as needed
      return date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
    } catch (e) {
      console.error("Error formatting date:", e);
      return "Invalid Date";
    }
  };

  // Helper function for status badge variant - Uses distinct valid variants
  const getStatusVariant = (
    status: WebinarStatus | ClassStatus,
  ): "default" | "secondary" | "destructive" | "outline" => {
    switch (status) {
      case WebinarStatus.SCHEDULED:
      case ClassStatus.SCHEDULED:
        return "default"; // Black background
      case WebinarStatus.IN_PROGRESS:
      case ClassStatus.IN_PROGRESS:
        return "secondary"; // Grey background for in progress
      case WebinarStatus.COMPLETED:
      case ClassStatus.COMPLETED:
        return "outline"; // Outline variant for completed
      case WebinarStatus.CANCELLED:
      case ClassStatus.CANCELLED:
        return "destructive"; // Red background for cancelled
      // No default needed as the input type is constrained to the enums
    }
  };

  return (
    <div className="flex items-center gap-4">
      {/* Main container for grid and pagination */}
      <div className="w-full">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 w-full">
          {/* Map over current page events */}
          {currentEvents.map((event) => {
            const { currentParticipants, maxParticipants } =
              getParticipantsCount(event);
            const status = getEventStatus(event);
            const startDate = getEventStartDate(event);

            return (
              <Card
                key={event.id}
                className="w-full bg-white shadow-lg rounded-lg overflow-hidden flex flex-col"
              >
                <CardHeader className="bg-gray-50 border-b flex-shrink-0 flex flex-row items-start justify-between p-4">
                  <div className="flex-grow mr-2 space-y-1">
                    <CardTitle className="text-lg font-semibold text-gray-800">
                      {getEventTitle(event)}
                    </CardTitle>
                    <CardDescription className="text-sm text-gray-600">
                      {getParticipantsDisplayText(
                        currentParticipants,
                        maxParticipants,
                      )}
                    </CardDescription>
                    {/* Only show timing and status for scheduled events (webinar and class), not for plans (consultation and subscription) */}
                    {(eventType === "webinar" || eventType === "class") && (
                      <div className="flex items-center gap-x-2 text-sm">
                        <span className="text-gray-500 font-medium whitespace-nowrap">
                          {formatDateTime(startDate)}
                        </span>
                        {startDate && status !== null && (
                          <Badge
                            variant={getStatusVariant(status)}
                            className="text-xs"
                          >
                            {status.toString().replace("_", " ")}
                          </Badge>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center space-x-1 flex-shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleEdit(event)}
                      className="h-8 w-8"
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(event)}
                      className="h-8 w-8 text-red-500 hover:text-red-700"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="p-4 flex-grow">
                  <p className="text-sm text-gray-700 mb-2 line-clamp-3">
                    {getEventDescription(event)}
                  </p>
                  <p className="text-sm font-medium text-gray-900">
                    Price: {getEventCurrency(event)} {getEventPrice(event)}
                  </p>
                  <p className="text-sm text-gray-600">
                    Duration: {getEventDuration(event)}
                  </p>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Pagination Controls */}
        {totalPages > 1 && (
          <div className="flex justify-center items-center gap-4 mt-6">
            <Button
              variant="outline"
              size="icon"
              onClick={goToPreviousPage}
              disabled={currentPage === 1}
            >
              <ChevronLeftIcon className="h-4 w-4" />
            </Button>
            <span className="text-sm text-gray-700">
              Page {currentPage} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="icon"
              onClick={goToNextPage}
              disabled={currentPage === totalPages}
            >
              <ChevronRightIcon className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
