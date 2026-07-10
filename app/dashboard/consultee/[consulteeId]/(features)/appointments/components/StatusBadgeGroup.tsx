"use client";

import { Building2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  WaitlistStatusBadge,
  type BookingStatus,
} from "@/components/ui/waitlist-status-badge";
import { eventUnionStatusBadge } from "../utils/status-guards";
import { resolveSponsoringOrgName } from "@/lib/labels/session-labels";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
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
  const sponsoringOrgName = resolveSponsoringOrgName(
    organizationId,
    session?.user?.organizationMemberships,
  );
  // Tentative slots read as PENDING regardless of the row status — the
  // consultant hasn't locked the time in yet.
  const displayStatusStyle = eventUnionStatusBadge(
    isTentative ? "PENDING" : status,
  );

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
      {sponsoringOrgName && (
        <Badge
          className="text-[10px] font-semibold px-2 py-0.5 bg-muted text-muted-foreground border-0 rounded-md inline-flex items-center gap-1 max-w-[200px]"
          title={`Sponsored by ${sponsoringOrgName}`}
        >
          <Building2 className="h-3 w-3 shrink-0" />
          <span className="truncate">Sponsored · {sponsoringOrgName}</span>
        </Badge>
      )}
      <Badge className="text-[10px] font-medium px-2 py-0.5 bg-transparent border border-border text-muted-foreground rounded-md">
        {eventType === "Trial" ? "Subscription" : eventType}
      </Badge>
      {eventType === "Trial" && (
        <Badge className="text-[10px] font-semibold px-2 py-0.5 bg-muted text-foreground border-0 rounded-md">
          Free Trial
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
        <StatusBadge {...displayStatusStyle} withDot size="sm" />
      )}
    </div>
  );
}
