"use client";

/**
 * The booking audit trail for one appointment, rendered inside the operator
 * appointment detail modal (#1319 PR 8, #448).
 *
 * Metadata only, by construction: the endpoint returns status edges,
 * attribution and proposal counts and nothing else, so there is no note, no
 * chat and no recording link to render here. ADR 20 keeps the whole surface
 * off the organization dashboards — staff and admin share this component
 * because they share the appointments page it lives on, and nobody else
 * reaches either.
 */

import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, History, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { formatOperatorInstant } from "@/lib/time/operator-zone";
import { humanizeEnum } from "@/lib/ui/tone";
import type {
  BookingTimeline,
  BookingTimelineEntry,
} from "@/lib/data/booking-history";

/**
 * `BookingHistoryEntity` values read as SQL enums; these are the operator's
 * words for the same lifecycles, and for one attendee's seat. An unknown key reads "Booking" rather
 * than printing the raw enum.
 */
const ENTITY_LABEL: Record<string, string> = {
  CONSULTATION: "Consultation",
  SUBSCRIPTION: "Subscription",
  WEBINAR: "Webinar",
  CLASS: "Class",
  TRIAL: "Trial",
  RESCHEDULE_REQUEST: "Reschedule",
  OCCURRENCE: "Session",
  SEAT: "Seat",
};

function entityLabel(entity: string): string {
  return ENTITY_LABEL[entity] ?? "Booking";
}

/** "3 hours ago", with the India-time instant one hover away. */
function RelativeTime({ iso }: Readonly<{ iso: string }>) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return <>unknown time</>;
  return (
    <time dateTime={at.toISOString()} title={formatOperatorInstant(at)}>
      {formatDistanceToNow(at, { addSuffix: true })}
    </time>
  );
}

/**
 * An unattributed row is a cron, a webhook or a sweep — every automated writer
 * omits `actorUserId`. Saying "system" is more honest than an empty cell.
 */
function actorLabel(entry: BookingTimelineEntry): string {
  return entry.actor?.name?.trim() || "system";
}

/** A seat row that keeps its status (a lift) is its reason, not an edge. */
function seatReasonOnly(entry: BookingTimelineEntry): boolean {
  return (
    entry.entity === "SEAT" && entry.from === entry.to && Boolean(entry.reason)
  );
}

/** A status edge in words ("Scheduled → Unverified"); a reschedule row is the proposal, its answer is an edge. */
export function timelineStepLabel(entry: BookingTimelineEntry): string {
  if (entry.kind === "reschedule") return "Proposed";
  if (seatReasonOnly(entry) && entry.reason) return entry.reason;
  const to = humanizeEnum(entry.to);
  return entry.from ? `${humanizeEnum(entry.from)} → ${to}` : to;
}

function TimelineRow({ entry }: { entry: BookingTimelineEntry }) {
  return (
    <li className="relative border-l border-border pl-4">
      <span className="absolute -left-[3px] top-2 h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="bg-muted text-muted-foreground">
          {entityLabel(entry.entity)}
          {entry.seatHolder?.name ? ` · ${entry.seatHolder.name}` : ""}
        </Badge>
        <span className="text-xs text-foreground">
          {timelineStepLabel(entry)}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {actorLabel(entry)} • <RelativeTime iso={entry.createdAt} />
        {entry.kind === "reschedule" && (
          <>
            {" • "}
            {entry.proposedSlotCount === 1
              ? "1 proposed time"
              : `${entry.proposedSlotCount ?? 0} proposed times`}
            {entry.outcome &&
              ` • now ${humanizeEnum(entry.outcome).toLowerCase()}`}
          </>
        )}
      </p>
      {entry.reason && !seatReasonOnly(entry) && (
        <p className="mt-1 text-xs text-muted-foreground/80">{entry.reason}</p>
      )}
    </li>
  );
}

export function AppointmentTimeline({
  appointmentId,
}: {
  appointmentId: string;
}) {
  const { data, isLoading, error } = useQuery<BookingTimeline>({
    queryKey: ["staff-appointment-timeline", appointmentId],
    queryFn: async () => {
      const response = await fetch(
        `/api/staff/appointments/${appointmentId}/timeline`,
      );
      if (!response.ok) throw new Error("Failed to fetch appointment timeline");
      return response.json();
    },
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
  });

  const entries = data?.entries ?? [];

  return (
    <div>
      <Label className="flex items-center gap-2 text-xs text-muted-foreground">
        <History className="h-3.5 w-3.5" />
        Timeline
      </Label>

      {isLoading ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading the audit trail…
        </div>
      ) : error ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <AlertTriangle className="h-3.5 w-3.5" />
          Could not load the audit trail.
        </div>
      ) : entries.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Nothing has moved on this booking yet.
        </p>
      ) : (
        <>
          <ul className="mt-3 max-h-64 space-y-3 overflow-y-auto pr-1">
            {entries.map((entry) => (
              <TimelineRow key={`${entry.kind}:${entry.id}`} entry={entry} />
            ))}
          </ul>
          {data?.truncated && (
            <p className="mt-2 text-xs text-muted-foreground/70">
              Showing the most recent {entries.length} events; older ones are
              not displayed.
            </p>
          )}
        </>
      )}
    </div>
  );
}
