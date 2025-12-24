"use client";

import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Edit,
  Trash2,
  Clock,
  MessageSquare,
  CalendarRange,
  Video,
  GraduationCap,
  Users,
} from "lucide-react";
import { cn } from "@/utils/tailwind";
import { WebinarStatus, ClassStatus } from "@prisma/client";
import {
  Event,
  WebinarEvent,
  ClassEvent,
  ConsultationPlanEvent,
  SubscriptionPlanEvent,
} from "../types/event";

type EventType = "consultation" | "subscription" | "webinar" | "class";

interface EventCardProps {
  event: Event;
  eventType: EventType;
  participantCount: number;
  onEdit: () => void;
  onDelete: () => void;
}

// Type guards
function isWebinarEvent(event: Event): event is WebinarEvent {
  return event.type === "webinar";
}

function isClassEvent(event: Event): event is ClassEvent {
  return event.type === "class";
}

function isConsultationPlanEvent(event: Event): event is ConsultationPlanEvent {
  return event.type === "consultation";
}

function isSubscriptionPlanEvent(
  event: Event,
): event is SubscriptionPlanEvent {
  return event.type === "subscription";
}

// Event type configuration
const eventTypeConfig: Record<
  EventType,
  {
    icon: typeof MessageSquare;
    iconBg: string;
    iconColor: string;
    gradientColor: string;
  }
> = {
  consultation: {
    icon: MessageSquare,
    iconBg: "bg-blue-50",
    iconColor: "text-blue-600",
    gradientColor: "from-blue-100/50",
  },
  subscription: {
    icon: CalendarRange,
    iconBg: "bg-purple-50",
    iconColor: "text-purple-600",
    gradientColor: "from-purple-100/50",
  },
  webinar: {
    icon: Video,
    iconBg: "bg-emerald-50",
    iconColor: "text-emerald-600",
    gradientColor: "from-emerald-100/50",
  },
  class: {
    icon: GraduationCap,
    iconBg: "bg-amber-50",
    iconColor: "text-amber-600",
    gradientColor: "from-amber-100/50",
  },
};

// Currency formatting utility
const formatCurrency = (price: number, currency: string) => {
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(price);
  } catch {
    return `${currency} ${price}`;
  }
};

// Helper functions for extracting event data
function getEventTitle(event: Event): string {
  if (isWebinarEvent(event)) return event.webinarPlan.title;
  if (isClassEvent(event)) return event.classPlan.title;
  if (isConsultationPlanEvent(event)) return event.consultationPlan.title;
  if (isSubscriptionPlanEvent(event)) return event.subscriptionPlan.title;
  return "";
}

function getEventDescription(event: Event): string {
  if (isWebinarEvent(event)) return event.webinarPlan.description ?? "";
  if (isClassEvent(event)) return event.classPlan.description ?? "";
  if (isConsultationPlanEvent(event))
    return event.consultationPlan.description ?? "";
  if (isSubscriptionPlanEvent(event))
    return event.subscriptionPlan.description ?? "";
  return "";
}

function getEventPrice(event: Event): number {
  if (isWebinarEvent(event)) return event.webinarPlan.price;
  if (isClassEvent(event)) return event.classPlan.price;
  if (isConsultationPlanEvent(event)) return event.consultationPlan.price;
  if (isSubscriptionPlanEvent(event)) return event.subscriptionPlan.price;
  return 0;
}

function getEventCurrency(event: Event): string {
  if (isWebinarEvent(event)) return event.webinarPlan.priceCurrency ?? "INR";
  if (isClassEvent(event)) return event.classPlan.priceCurrency ?? "INR";
  if (isConsultationPlanEvent(event))
    return event.consultationPlan.priceCurrency ?? "INR";
  if (isSubscriptionPlanEvent(event))
    return event.subscriptionPlan.priceCurrency ?? "INR";
  return "INR";
}

function getEventDuration(event: Event): string {
  if (isWebinarEvent(event)) {
    const hours = event.webinarPlan.durationInHours;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  if (isClassEvent(event)) {
    const months = event.classPlan.durationInMonths;
    return months === 1 ? "1 month" : `${months} months`;
  }
  if (isConsultationPlanEvent(event)) {
    const hours = event.consultationPlan.durationInHours;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  if (isSubscriptionPlanEvent(event)) {
    const months = event.subscriptionPlan.durationInMonths;
    return months === 1 ? "1 month" : `${months} months`;
  }
  return "";
}

function getMaxParticipants(event: Event): number {
  if (isWebinarEvent(event)) return event.webinarPlan.maxParticipants;
  if (isClassEvent(event)) return event.classPlan.maxParticipants;
  // Consultations and subscriptions are 1-on-1
  return 1;
}

function getEventStatus(event: Event): WebinarStatus | ClassStatus | null {
  if (isWebinarEvent(event)) return event.status ?? null;
  if (isClassEvent(event)) return event.status ?? null;
  return null;
}

function getEventStartDate(event: Event): Date | null {
  if (isWebinarEvent(event)) {
    const startTimeString =
      event.appointment?.slotsOfAppointment?.[0]?.startsAt;
    return startTimeString ? new Date(startTimeString) : null;
  }
  if (isClassEvent(event)) {
    return event.schedulingPeriodStartsAt
      ? new Date(event.schedulingPeriodStartsAt)
      : null;
  }
  return null;
}

function formatDateTime(date: Date | null): string {
  if (!date) return "Unscheduled";
  try {
    return date.toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return "Invalid Date";
  }
}

function getStatusVariant(
  status: WebinarStatus | ClassStatus,
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case WebinarStatus.SCHEDULED:
    case ClassStatus.SCHEDULED:
      return "default";
    case WebinarStatus.IN_PROGRESS:
    case ClassStatus.IN_PROGRESS:
      return "secondary";
    case WebinarStatus.COMPLETED:
    case ClassStatus.COMPLETED:
      return "outline";
    case WebinarStatus.CANCELLED:
    case ClassStatus.CANCELLED:
      return "destructive";
  }
}

export function EventCard({
  event,
  eventType,
  participantCount,
  onEdit,
  onDelete,
}: Readonly<EventCardProps>) {
  const config = eventTypeConfig[eventType];
  const Icon = config.icon;

  const title = getEventTitle(event);
  const description = getEventDescription(event);
  const price = getEventPrice(event);
  const currency = getEventCurrency(event);
  const duration = getEventDuration(event);
  const maxParticipants = getMaxParticipants(event);
  const status = getEventStatus(event);
  const startDate = getEventStartDate(event);

  const isLiveSession = eventType === "webinar" || eventType === "class";
  const durationSuffix =
    eventType === "subscription" || eventType === "class" ? "/mo" : "";

  return (
    <motion.div
      whileHover={{ y: -4, boxShadow: "0 12px 40px -12px rgba(0, 0, 0, 0.15)" }}
      transition={{ duration: 0.2 }}
      className="group relative overflow-hidden rounded-xl border border-zinc-200/80 bg-white p-5"
    >
      {/* Decorative gradient blob */}
      <div
        className={cn(
          "absolute -right-8 -top-8 h-24 w-24 rounded-full bg-gradient-to-br to-transparent opacity-60",
          config.gradientColor,
        )}
      />

      {/* Hover action buttons */}
      <div className="absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all duration-200 transform translate-y-1 group-hover:translate-y-0 z-10">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 bg-white/90 backdrop-blur-sm shadow-sm hover:bg-white border border-zinc-200/60"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
        >
          <Edit className="h-4 w-4 text-zinc-600" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 bg-white/90 backdrop-blur-sm shadow-sm hover:bg-red-50 border border-zinc-200/60"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <Trash2 className="h-4 w-4 text-zinc-400 hover:text-red-500" />
        </Button>
      </div>

      {/* Main content */}
      <div className="flex items-start gap-4">
        {/* Icon badge */}
        <div
          className={cn(
            "flex h-11 w-11 items-center justify-center rounded-xl shrink-0",
            config.iconBg,
          )}
        >
          <Icon className={cn("h-5 w-5", config.iconColor)} />
        </div>

        {/* Content area */}
        <div className="flex-1 min-w-0 pr-16">
          <h3 className="font-semibold text-zinc-900 truncate">{title}</h3>
          <p className="text-sm text-zinc-500 line-clamp-2 mt-1">
            {description || "No description provided"}
          </p>
        </div>
      </div>

      {/* Live session info (webinar/class only) */}
      {isLiveSession && (
        <div className="mt-4 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-zinc-500 font-medium">
            {formatDateTime(startDate)}
          </span>
          {status && (
            <Badge variant={getStatusVariant(status)} className="text-xs">
              {status.toString().replace("_", " ")}
            </Badge>
          )}
        </div>
      )}

      {/* Participants row */}
      <div className="mt-3 flex items-center gap-1.5 text-xs text-zinc-500">
        <Users className="h-3.5 w-3.5" />
        <span>
          {participantCount}/{maxParticipants} participants
        </span>
      </div>

      {/* Price/Duration row */}
      <div className="mt-4 pt-4 border-t border-zinc-100 flex items-center justify-between">
        <div className="flex items-baseline gap-1">
          <span className="text-xl font-bold tracking-tight text-zinc-900">
            {formatCurrency(price, currency)}
          </span>
          {durationSuffix && (
            <span className="text-sm text-zinc-400">{durationSuffix}</span>
          )}
        </div>

        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600">
          <Clock className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">{duration}</span>
        </div>
      </div>
    </motion.div>
  );
}
