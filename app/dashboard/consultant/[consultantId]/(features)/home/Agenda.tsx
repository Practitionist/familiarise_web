import Link from "next/link";

import { Section } from "@/components/dashboard/Section";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { getAppointmentLifecycleStatus } from "@/lib/appointments/map-consultant";
import { eventUnionStatusBadge } from "@/lib/appointments/status";
import { formatForViewer, type ViewerZone } from "@/lib/time/viewer-zone";

import { ArrowLink } from "./ArrowLink";
import { SESSION_PATTERN, type Agenda, type HomeSession } from "./home-model";

function AgendaList({
  title,
  sessions,
  consultantId,
  viewerZone,
  pattern,
}: Readonly<{
  title: string;
  sessions: readonly HomeSession[];
  consultantId: string;
  viewerZone: ViewerZone;
  pattern: string;
}>) {
  if (sessions.length === 0) return null;
  return (
    <Section title={title}>
      <ul className="divide-y divide-border rounded-xl border border-border bg-card shadow-elevation-1">
        {sessions.map((session) => (
          <li key={session.occurrenceId}>
            <Link
              href={`/dashboard/consultant/${consultantId}/appointments/${session.appointment.id}`}
              className="grid grid-cols-[7.5rem_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[10rem_minmax(0,1fr)_auto]"
            >
              <span className="tabular-nums text-muted-foreground">
                {formatForViewer(session.startsAt, viewerZone, pattern)}
              </span>
              <span className="min-w-0 truncate">
                <span className="font-medium text-foreground">
                  {session.title}
                </span>
                <span className="text-muted-foreground">
                  {" "}
                  · {session.subtitle}
                </span>
              </span>
              <StatusBadge
                {...eventUnionStatusBadge(
                  getAppointmentLifecycleStatus(session.appointment),
                )}
                size="sm"
              />
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** What follows the next session: today's remaining sessions, then the days after. */
export function AgendaLists({
  agenda,
  consultantId,
  viewerZone,
}: Readonly<{
  agenda: Agenda;
  consultantId: string;
  viewerZone: ViewerZone;
}>) {
  if (agenda.today.length === 0 && agenda.upcoming.length === 0) return null;
  return (
    <div className="space-y-8">
      <AgendaList
        title="Today"
        sessions={agenda.today}
        consultantId={consultantId}
        viewerZone={viewerZone}
        pattern="h:mm a"
      />
      <AgendaList
        title="Upcoming"
        sessions={agenda.upcoming}
        consultantId={consultantId}
        viewerZone={viewerZone}
        pattern={SESSION_PATTERN}
      />
      <ArrowLink href={`/dashboard/consultant/${consultantId}/appointments`}>
        {agenda.hidden > 0
          ? `All appointments (${agenda.hidden} more)`
          : "All appointments"}
      </ArrowLink>
    </div>
  );
}
