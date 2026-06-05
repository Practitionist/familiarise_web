"use client";

import { Building2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  WaitlistStatusBadge,
  type BookingStatus,
} from "@/components/ui/waitlist-status-badge";
import {
  STATUS_CONFIG,
  formatStatusLabel,
} from "../../../utils/statusConfig";
import { cn } from "@/utils/tailwind";
import { useSession } from "@/lib/auth-client";

interface StatusBadgeGroupProps {
  eventType: "Consultation" | "Subscription" | "Webinar" | "Class" | "Trial";
  status: string;
  isTentative: boolean;
  bookingStatus?: BookingStatus;
  waitlistPosition?: number;
  /**
   * `Appointment.organizationId` from the row, when present. Drives the
   * "Sponsored by <Org>" badge so an org-funded session is visually
   * distinct from a personal booking on the consultee dashboard.
   */
  organizationId?: string | null;
}

export function StatusBadgeGroup({
  eventType,
  status,
  isTentative,
  bookingStatus,
  waitlistPosition,
  organizationId,
}: StatusBadgeGroupProps) {
  const { data: session } = useSession();
  const sponsoringOrgName = organizationId
    ? (session?.user?.organizationMemberships?.find(
        (m) => m.organizationId === organizationId,
      )?.organizationName ?? "your organization")
    : null;
  const statusStyle =
    STATUS_CONFIG[status?.toUpperCase()] || STATUS_CONFIG.PENDING;
  const displayStatus = isTentative ? "PENDING" : status?.toUpperCase();
  const displayStatusStyle = isTentative ? STATUS_CONFIG.PENDING : statusStyle;

  const isTerminal = ["cancelled", "rejected", "completed", "expired"].includes(
    status?.toLowerCase(),
  );

  // Show WaitlistStatusBadge only for active webinars/classes — not terminal ones
  const showWaitlistBadge =
    (eventType === "Webinar" || eventType === "Class") &&
    !!bookingStatus &&
    !isTerminal;

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
      {sponsoringOrgName && (
        <Badge
          className="text-[10px] font-semibold px-2 py-0.5 bg-indigo-50 text-indigo-700 border-0 rounded-md flex items-center gap-1"
          title="This session is sponsored by your organization"
        >
          <Building2 className="h-3 w-3" />
          Sponsored · {sponsoringOrgName}
        </Badge>
      )}
      {showWaitlistBadge ? (
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
            className={cn("h-1.5 w-1.5 rounded-full", displayStatusStyle.dot)}
          />
          {formatStatusLabel(displayStatus ?? "")}
        </Badge>
      )}
    </div>
  );
}
