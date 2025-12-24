"use client";

import React from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { ChevronLeftIcon, ChevronRightIcon } from "@radix-ui/react-icons";
import {
  MessageSquare,
  CalendarRange,
  Video,
  GraduationCap,
} from "lucide-react";
import { cn } from "@/utils/tailwind";
import {
  WebinarEvent,
  ClassEvent,
  ConsultationPlanEvent,
  SubscriptionPlanEvent,
  Event,
} from "../types/event";
import { EventCard } from "./EventCard";

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

// Empty state configuration
const emptyStateConfig = {
  webinar: {
    icon: Video,
    title: "No webinars scheduled",
    description:
      "Create your first webinar to start hosting live sessions with multiple participants.",
    iconBg: "bg-emerald-50",
    iconColor: "text-emerald-600",
  },
  class: {
    icon: GraduationCap,
    title: "No classes created",
    description:
      "Design structured learning experiences with multi-session classes.",
    iconBg: "bg-amber-50",
    iconColor: "text-amber-600",
  },
  consultation: {
    icon: MessageSquare,
    title: "No consultation plans",
    description:
      "Create consultation plans to offer one-on-one sessions to your clients.",
    iconBg: "bg-blue-50",
    iconColor: "text-blue-600",
  },
  subscription: {
    icon: CalendarRange,
    title: "No subscription plans",
    description: "Set up subscription plans for ongoing mentorship relationships.",
    iconBg: "bg-purple-50",
    iconColor: "text-purple-600",
  },
};

// Animation variants
const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.08,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.3,
      ease: "easeOut",
    },
  },
};

export function EventCarousel({
  events,
  onEdit,
  onDelete,
  eventType,
  participantCounts,
}: EventCarouselProps) {
  const [currentPage, setCurrentPage] = React.useState(1);
  const itemsPerPage = 8;

  // Calculate pagination
  const totalPages = Math.ceil(events.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const currentEvents = events.slice(startIndex, endIndex);

  const goToNextPage = () => {
    setCurrentPage((prev) => Math.min(prev + 1, totalPages));
  };

  const goToPreviousPage = () => {
    setCurrentPage((prev) => Math.max(prev - 1, 1));
  };

  const getEventTitle = (event: Event): string => {
    if (isWebinarEvent(event)) return event.webinarPlan.title;
    if (isClassEvent(event)) return event.classPlan.title;
    if (isConsultationPlanEvent(event)) return event.consultationPlan.title;
    if (isSubscriptionPlanEvent(event)) return event.subscriptionPlan.title;
    return "";
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
      } catch (error) {
        console.error(`Error deleting ${eventType}:`, error);
      }
    }
  };

  // Empty state
  if (events.length === 0) {
    const config = emptyStateConfig[eventType];
    const Icon = config.icon;

    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="flex flex-col items-center justify-center py-16 text-center rounded-xl border border-dashed border-zinc-200 bg-zinc-50/50"
      >
        <div
          className={cn(
            "mb-4 flex h-16 w-16 items-center justify-center rounded-2xl",
            config.iconBg,
          )}
        >
          <Icon className={cn("h-8 w-8", config.iconColor)} />
        </div>
        <h4 className="text-lg font-semibold text-zinc-900">{config.title}</h4>
        <p className="mt-2 text-sm text-zinc-500 max-w-sm px-4">
          {config.description}
        </p>
      </motion.div>
    );
  }

  return (
    <div className="w-full">
      <motion.div
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5 w-full"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
        key={currentPage} // Re-animate on page change
      >
        {currentEvents.map((event) => (
          <motion.div key={event.id} variants={itemVariants}>
            <EventCard
              event={event}
              eventType={eventType}
              participantCount={participantCounts[event.id ?? ""] ?? 0}
              onEdit={() => handleEdit(event)}
              onDelete={() => handleDelete(event)}
            />
          </motion.div>
        ))}
      </motion.div>

      {/* Pagination Controls */}
      {totalPages > 1 && (
        <div className="flex justify-center items-center gap-4 mt-8">
          <Button
            variant="outline"
            size="icon"
            onClick={goToPreviousPage}
            disabled={currentPage === 1}
            className="h-9 w-9"
          >
            <ChevronLeftIcon className="h-4 w-4" />
          </Button>
          <span className="text-sm text-zinc-600">
            Page {currentPage} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="icon"
            onClick={goToNextPage}
            disabled={currentPage === totalPages}
            className="h-9 w-9"
          >
            <ChevronRightIcon className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
