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
import { Users, Edit, Clock, Trash2 } from "lucide-react";
import { EventTimingsCalendar } from "./EventTimingsCalendar"
import Link from "next/link";
import { ChevronLeftIcon, ChevronRightIcon } from "@radix-ui/react-icons";
import { WebinarEvent, ClassEvent, Event } from "../types/event";
import { Badge } from "@/components/ui/badge";
import { WebinarStatus, ClassStatus } from "@prisma/client";

interface WebinarCarouselProps {
  events: WebinarEvent[];
  onEdit: (event: WebinarEvent) => void;
  onDelete: (eventId: string) => Promise<void>;
  eventType: "webinar";
}

interface ClassCarouselProps {
  events: ClassEvent[];
  onEdit: (event: ClassEvent) => void;
  onDelete: (eventId: string) => Promise<void>;
  eventType: "class";
}

type EventCarouselProps = WebinarCarouselProps | ClassCarouselProps;

function isWebinarEvent(event: Event): event is WebinarEvent {
  return event.type === "webinar";
}

function isClassEvent(event: Event): event is ClassEvent {
  return event.type === "class";
}

export function EventCarousel({
  events,
  onEdit,
  onDelete,
  eventType,
}: EventCarouselProps) {
  const [selectedEventId, setSelectedEventId] = React.useState<string | null>(
    null,
  );
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
    throw new Error(`Unknown event type encountered.`);
  };

  const getEventDescription = (event: Event): string => {
    if (isWebinarEvent(event)) {
      return event.webinarPlan.description ?? "";
    }
    if (isClassEvent(event)) {
      return event.classPlan.description ?? "";
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
    throw new Error(`Unknown event type encountered.`);
  };

  const getEventCurrency = (event: Event): string => {
    if (isWebinarEvent(event)) {
      return event.webinarPlan.priceCurrency ?? "INR"; // Default to INR if null/undefined
    }
    if (isClassEvent(event)) {
      return event.classPlan.priceCurrency ?? "INR"; // Default to INR if null/undefined
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
    throw new Error(`Unknown event type encountered.`);
  };

  const [participantCounts, setParticipantCounts] = React.useState<
    Record<string, number>
  >({});
  const [isLoadingCounts, setIsLoadingCounts] = React.useState(true);

  React.useEffect(() => {
    const fetchParticipantCounts = async () => {
      setIsLoadingCounts(true);
      try {
        for (const event of events) {
          try {
            let endpoint: string;
            if (isWebinarEvent(event)) {
              endpoint = `/api/participants/webinar/${event.id}`;
            } else {
              endpoint = `/api/participants/class/${event.id}`;
            }

            const response = await fetch(endpoint);
            if (response.ok) {
              const data = await response.json();
              setParticipantCounts((prev) => ({
                ...prev,
                [event.id]: data.participants.length,
              }));
            }
          } catch (error) {
            console.error("Error fetching participant count:", error);
          }
        }
      } finally {
        setIsLoadingCounts(false);
      }
    };

    if (events.length > 0) {
      fetchParticipantCounts();
    }
  }, [events]);

  const getParticipantsCount = (event: Event) => {
    let maxParticipants = 0;

    if (isWebinarEvent(event)) {
      maxParticipants = event.webinarPlan.maxParticipants;
    } else if (isClassEvent(event)) {
      maxParticipants = event.classPlan.maxParticipants;
    }

    return {
      currentParticipants: participantCounts[event.id] ?? 0,
      maxParticipants,
    };
  };

  const handleEdit = (event: Event) => {
    if (eventType === "webinar" && isWebinarEvent(event)) {
      onEdit(event);
    } else if (eventType === "class" && isClassEvent(event)) {
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
        await onDelete(event.id);
        // Optionally show a success toast, though parent might handle it
      } catch (error) {
        console.error(`Error deleting ${eventType}:`, error);
        // Optionally show an error toast
      }
    }
  };

  // Helper function to get profile URL
  const getProfileUrl = (event: Event) => {
    if (isWebinarEvent(event)) {
      return `/dashboard/consultant/${event.webinarPlan.consultantProfileId}/planner/participants/webinars/${event.id}`;
    }
    if (isClassEvent(event)) {
      return `/dashboard/consultant/${event.classPlan.consultantProfileId}/planner/participants/classes/${event.id}`;
    }
    return "#";
  };

  // Helper function for participant display text
  const getParticipantsDisplayText = (
    isLoading: boolean,
    current: number,
    max: number,
  ) => {
    if (isLoading) {
      return "Loading participants...";
    }
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
        event.appointment?.slotsOfAppointment?.[0]?.slotStartTimeInUTC;
      return startTimeString ? new Date(startTimeString) : null;
    }
    if (isClassEvent(event)) {
      return event.startDate ? new Date(event.startDate) : null;
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
                        isLoadingCounts,
                        currentParticipants,
                        maxParticipants,
                      )}
                    </CardDescription>
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
                <CardFooter className="bg-gray-50 border-t p-4 flex justify-between flex-shrink-0">
                  <Button variant="outline" size="sm" asChild>
                    <Link href={getProfileUrl(event)}>
                      <Users className="w-4 h-4 mr-2" />
                      Manage Participants
                    </Link>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSelectedEventId(event.id)}
                  >
                    <Clock className="w-4 h-4 mr-2" />
                    Manage Timings
                  </Button>
                </CardFooter>
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

      <EventTimingsCalendar
        isOpen={!!selectedEventId}
        onClose={() => setSelectedEventId(null)}
        eventType={eventType}
        eventId={selectedEventId ?? ""}
      />
    </div>
  );
}
