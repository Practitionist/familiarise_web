"use client";

import { Badge } from "@/components/ui/badge";
import {
  WaitlistStatusBadge,
  type BookingStatus,
} from "@/components/ui/waitlist-status-badge";
import { STATUS_CONFIG } from "../../../utils/statusConfig";
import { cn } from "@/utils/tailwind";

interface StatusBadgeGroupProps {
  eventType: "Consultation" | "Subscription" | "Webinar" | "Class" | "Trial";
  status: string;
  isTentative: boolean;
  bookingStatus?: BookingStatus;
  waitlistPosition?: number;
}

export function StatusBadgeGroup({
  eventType,
  status,
  isTentative,
  bookingStatus,
  waitlistPosition,
}: StatusBadgeGroupProps) {
  const statusStyle =
    STATUS_CONFIG[status?.toUpperCase()] || STATUS_CONFIG.PENDING;
  const displayStatus = isTentative ? "PENDING" : status?.toUpperCase();
  const displayStatusStyle = isTentative ? STATUS_CONFIG.PENDING : statusStyle;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Badge className="text-[10px] font-medium px-2 py-0.5 bg-transparent border border-zinc-300 text-zinc-600 rounded-md">
        {eventType === "Trial" ? "Subscription" : eventType}
      </Badge>
      {eventType === "Trial" && (
        <Badge className="text-[10px] font-semibold px-2 py-0.5 bg-emerald-50 text-emerald-700 border-0 rounded-md">
          Free Trial
        </Badge>
      )}
      {(eventType === "Webinar" || eventType === "Class") && bookingStatus ? (
        <WaitlistStatusBadge
          bookingStatus={bookingStatus}
          waitlistPosition={waitlistPosition}
          size="sm"
          showIcon={false}
        />
      ) : (
        <Badge
          className={cn(
            "text-[10px] font-semibold px-2 py-0.5 border-0 flex items-center gap-1",
            displayStatusStyle.bg,
            displayStatusStyle.text,
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              displayStatusStyle.dot,
            )}
          />
          {displayStatusStyle.label || displayStatus?.replace(/_/g, " ")}
        </Badge>
      )}
    </div>
  );
}
