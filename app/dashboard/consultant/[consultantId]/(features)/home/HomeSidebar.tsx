import Link from "next/link";

import { Section } from "@/components/dashboard/Section";
import { Button } from "@/components/ui/button";
import {
  RequestsInboxPreview,
  type HomeRequestsQuery,
} from "@/components/dashboard/shared/requests/RequestsInboxPreview";
import {
  CONSULTANT_JOIN_WINDOW_MS,
  getOccurrenceJoinState,
  type OccurrenceJoinState,
} from "@/lib/appointments/occurrences";
import { formatForViewer, type ViewerZone } from "@/lib/time/viewer-zone";
import type { TConsultantDashboardResponse } from "@/types/consultant-events";

import { ArrowLink } from "./ArrowLink";
import { SESSION_PATTERN, type GlanceRow } from "./home-model";

const ORG_JOIN_STATE_LABEL: Record<OccurrenceJoinState, string> = {
  joinable: "Open to join",
  countdown: "Upcoming",
  ended: "Ended",
  disabled: "Not joinable",
};

export function RequestsPanel({
  consultantId,
  query,
}: Readonly<{ consultantId: string; query: HomeRequestsQuery }>) {
  return (
    <Section
      title="Requests"
      variant="card"
      actions={
        <ArrowLink href={`/dashboard/consultant/${consultantId}/requests`}>
          Open Requests
        </ArrowLink>
      }
    >
      <RequestsInboxPreview consultantProfileId={consultantId} query={query} />
    </Section>
  );
}

/** Plain label/value rows; the panel is absent when there is nothing true to say. */
export function GlancePanel({
  rows,
}: Readonly<{ rows: readonly GlanceRow[] }>) {
  if (rows.length === 0) return null;
  return (
    <Section title="At a glance" variant="card">
      <dl className="divide-y divide-border text-sm">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-baseline justify-between gap-3 py-2 first:pt-0 last:pb-0"
          >
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="text-right font-medium tabular-nums text-foreground">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

/**
 * Org-funded sessions this expert delivers. Home pins personal scope
 * everywhere else, so without this a session they must show up for never
 * appeared. Metadata only: organisation, time, join state.
 */
export function OrgSessionsPanel({
  sessions,
  memberOrgIds,
  viewerZone,
  now,
}: Readonly<{
  sessions: TConsultantDashboardResponse["orgSessions"];
  memberOrgIds: ReadonlySet<string>;
  viewerZone: ViewerZone;
  now: Date;
}>) {
  if (sessions.length === 0) return null;
  return (
    <Section title="Organisation sessions" variant="card">
      <ul className="divide-y divide-border text-sm">
        {sessions.map((session) => {
          const joinState = getOccurrenceJoinState(
            { id: session.occurrenceId, ...session },
            { joinWindowMs: CONSULTANT_JOIN_WINDOW_MS, now },
          );
          return (
            <li
              key={session.occurrenceId}
              className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
            >
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground">
                  {session.organizationName}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatForViewer(
                    session.startsAt,
                    viewerZone,
                    SESSION_PATTERN,
                  )}
                </p>
              </div>
              {/* The org dashboard owns the session; only a member can open it there. */}
              {memberOrgIds.has(session.organizationId) ? (
                <Button asChild variant="outline" size="sm">
                  <Link
                    href={`/dashboard/organization/${session.organizationId}/appointments`}
                  >
                    {ORG_JOIN_STATE_LABEL[joinState]}
                  </Link>
                </Button>
              ) : (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {ORG_JOIN_STATE_LABEL[joinState]}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/** Read-only busy time: sessions booked as a client with another expert. */
export function ClientBookingsPanel({
  bookings,
  viewerZone,
}: Readonly<{
  bookings: NonNullable<TConsultantDashboardResponse["clientBookings"]>;
  viewerZone: ViewerZone;
}>) {
  if (bookings.length === 0) return null;
  return (
    <Section title="Booked as a client" variant="card">
      <ul className="divide-y divide-border text-sm">
        {bookings.map((booking) => (
          <li
            key={booking.occurrenceId}
            className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
          >
            <div className="min-w-0">
              <p className="truncate font-medium text-foreground">
                With {booking.expertName}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatForViewer(booking.startsAt, viewerZone, SESSION_PATTERN)}
              </p>
            </div>
            {booking.href ? (
              <Button asChild variant="outline" size="sm">
                <Link href={booking.href}>Open</Link>
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}
