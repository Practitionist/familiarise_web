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
import { Users, Edit, Clock } from "lucide-react";
import { TimingsCalendar } from "./TimingsCalendar";
import Link from "next/link";
import { ChevronLeftIcon, ChevronRightIcon } from "@radix-ui/react-icons";
import { WebinarEvent, ClassEvent, Event } from "../types/event";

interface WebinarCarouselProps {
  events: WebinarEvent[];
  onEdit: (event: WebinarEvent) => void;
  eventType: "webinar";
}

interface ClassCarouselProps {
  events: ClassEvent[];
  onEdit: (event: ClassEvent) => void;
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

  const getEventTitle = (event: Event) => {
    if (isWebinarEvent(event)) {
      return event.webinarPlan.title;
    }
    if (isClassEvent(event)) {
      return event.classPlan.title;
    }
    return "Unknown Event";
  };

  const getEventDescription = (event: Event) => {
    if (isWebinarEvent(event)) {
      return event.webinarPlan.description ?? "";
    }
    if (isClassEvent(event)) {
      return event.classPlan.description ?? "";
    }
    return "";
  };

  const getEventPrice = (event: Event) => {
    if (isWebinarEvent(event)) {
      return event.webinarPlan.price;
    }
    if (isClassEvent(event)) {
      return event.classPlan.price;
    }
    return 0;
  };

  const getEventDuration = (event: Event) => {
    if (isWebinarEvent(event)) {
      return `${event.webinarPlan.durationInHours} hours`;
    }
    if (isClassEvent(event)) {
      return `${event.classPlan.durationInMonths} months`;
    }
    return "Unknown duration";
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

  return (
    <div className="flex items-center gap-4">
      {/* Main container for grid and pagination */}
      <div className="w-full">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 w-full">
          {/* Map over current page events */}
          {currentEvents.map((event) => {
            const { currentParticipants, maxParticipants } =
              getParticipantsCount(event);

            return (
              <Card
                key={event.id}
                className="w-full bg-white shadow-lg rounded-lg overflow-hidden flex flex-col"
              >
                <CardHeader className="bg-gray-50 border-b relative flex-shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute right-4 top-4"
                    onClick={() => handleEdit(event)}
                  >
                    <Edit className="h-4 w-4" />
                  </Button>
                  <CardTitle className="text-lg font-semibold text-gray-800 pr-8">
                    {getEventTitle(event)}
                  </CardTitle>
                  <CardDescription className="text-sm text-gray-600">
                    {getParticipantsDisplayText(
                      isLoadingCounts,
                      currentParticipants,
                      maxParticipants,
                    )}
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-4 flex-grow">
                  <p className="text-sm text-gray-700 mb-2">
                    {getEventDescription(event)}
                  </p>
                  <p className="text-sm font-medium text-gray-900">
                    Price: ${getEventPrice(event)}
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

      <TimingsCalendar
        isOpen={!!selectedEventId}
        onClose={() => setSelectedEventId(null)}
        eventType={eventType}
        eventId={selectedEventId ?? ""}
      />
    </div>
  );
}
