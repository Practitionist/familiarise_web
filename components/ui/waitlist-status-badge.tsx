"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Clock, Sparkles } from "lucide-react";

export type BookingStatus = "CONFIRMED" | "WAITLISTED" | "NOTIFIED" | null;

interface WaitlistStatusBadgeProps {
  bookingStatus: BookingStatus;
  waitlistPosition?: number;
  className?: string;
  showIcon?: boolean;
  size?: "sm" | "default";
}

const statusConfig = {
  CONFIRMED: {
    label: "Confirmed",
    bg: "bg-green-100 hover:bg-green-100",
    text: "text-green-800",
    border: "border-green-200",
    icon: CheckCircle2,
  },
  WAITLISTED: {
    label: "On Waitlist",
    bg: "bg-amber-100 hover:bg-amber-100",
    text: "text-amber-800",
    border: "border-amber-200",
    icon: Clock,
  },
  NOTIFIED: {
    label: "Spot Available!",
    bg: "bg-blue-100 hover:bg-blue-100",
    text: "text-blue-800",
    border: "border-blue-200",
    icon: Sparkles,
  },
};

/**
 * Displays a booking status badge for webinars and classes
 *
 * - CONFIRMED (green): User has paid and has a slot
 * - WAITLISTED (amber): User is on waitlist with position
 * - NOTIFIED (blue, animated): A spot is available for the user
 */
export function WaitlistStatusBadge({
  bookingStatus,
  waitlistPosition,
  className,
  showIcon = true,
  size = "default",
}: WaitlistStatusBadgeProps) {
  if (!bookingStatus) return null;

  const config = statusConfig[bookingStatus];
  const Icon = config.icon;

  // Build label with position for waitlisted users
  const label =
    bookingStatus === "WAITLISTED" && waitlistPosition
      ? `Waitlist #${waitlistPosition}`
      : config.label;

  return (
    <Badge
      variant="outline"
      className={cn(
        config.bg,
        config.text,
        config.border,
        size === "sm" ? "text-xs px-2 py-0.5" : "text-sm px-2.5 py-1",
        // Add pulse animation for NOTIFIED status to draw attention
        bookingStatus === "NOTIFIED" && "animate-pulse",
        className,
      )}
    >
      {showIcon && (
        <Icon
          className={cn("mr-1", size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5")}
        />
      )}
      {label}
    </Badge>
  );
}

/**
 * Utility function to determine booking status from event data
 */
export function determineBookingStatus(
  hasConfirmedSlot: boolean,
  waitlistEntry?: { status: string; position?: number | null } | null,
): { bookingStatus: BookingStatus; waitlistPosition?: number } {
  if (hasConfirmedSlot) {
    return { bookingStatus: "CONFIRMED" };
  }

  if (waitlistEntry) {
    if (waitlistEntry.status === "NOTIFIED") {
      return { bookingStatus: "NOTIFIED" };
    }
    if (waitlistEntry.status === "WAITING") {
      return {
        bookingStatus: "WAITLISTED",
        waitlistPosition: waitlistEntry.position ?? undefined,
      };
    }
  }

  return { bookingStatus: null };
}
