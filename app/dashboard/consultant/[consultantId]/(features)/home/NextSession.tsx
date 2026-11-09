import Link from "next/link";
import { Video } from "lucide-react";

import { Section } from "@/components/dashboard/Section";
import { Button } from "@/components/ui/button";
import { formatForViewer, type ViewerZone } from "@/lib/time/viewer-zone";

import {
  SESSION_PATTERN,
  THEN_LIMIT,
  canJoinNow,
  formatDuration,
  joinOpensLabel,
  relativeWhen,
  sessionMinutes,
  type HomeSession,
} from "./home-model";

/**
 * The one session to prepare for: when it is, who it is with, and a Join that
 * opens at the join window. Later sessions follow on a single "Then:" line.
 */
export function NextSession({
  sessions,
  consultantId,
  viewerZone,
  now,
  sponsorName,
  showDevJoin,
  onJoin,
}: Readonly<{
  sessions: readonly HomeSession[];
  consultantId: string;
  viewerZone: ViewerZone;
  now: Date;
  /** The organisation funding the next session, when one does. */
  sponsorName?: string | null;
  /** Dev builds only: a Join that ignores the window. */
  showDevJoin?: boolean;
  onJoin: (session: HomeSession) => void;
}>) {
  const [next, ...later] = sessions;
  const base = `/dashboard/consultant/${consultantId}`;

  if (!next) {
    return (
      <Section title="Next session">
        <p className="text-sm text-muted-foreground">
          Nothing booked.{" "}
          <Link
            href={`${base}/availability`}
            className="font-medium text-foreground underline underline-offset-4"
          >
            Set your availability
          </Link>{" "}
          so learners can book.
        </p>
      </Section>
    );
  }

  const joinable = canJoinNow(next, now);
  const minutes = sessionMinutes(next);
  const facts = [
    next.subtitle,
    minutes ? formatDuration(minutes) : null,
    sponsorName ? `Sponsored by ${sponsorName}` : null,
  ].filter((fact): fact is string => fact !== null);
  const then = later.slice(0, THEN_LIMIT);

  return (
    <Section title="Next session">
      <div className="rounded-xl border border-border bg-card p-5 shadow-elevation-1">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div className="min-w-0 flex-1">
            <p className="text-lg font-semibold tracking-tight text-foreground">
              {relativeWhen(next, now, viewerZone.zone)}
              <span className="font-normal text-muted-foreground">
                {" "}
                · {formatForViewer(next.startsAt, viewerZone, SESSION_PATTERN)}
              </span>
            </p>
            <p className="mt-1 truncate text-sm">
              <Link
                href={`${base}/appointments/${next.appointment.id}`}
                className="font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {next.title}
              </Link>
            </p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {facts.join(" · ")}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-stretch gap-2">
            <Button
              disabled={!joinable}
              onClick={() => onJoin(next)}
              className="gap-1.5"
            >
              <Video aria-hidden />
              {joinable ? "Join" : joinOpensLabel(next, viewerZone)}
            </Button>
            {showDevJoin && !joinable && (
              <Button variant="outline" size="sm" onClick={() => onJoin(next)}>
                Join (Dev)
              </Button>
            )}
          </div>
        </div>
        {then.length > 0 && (
          <p className="mt-4 border-t border-border pt-3 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Then:</span>{" "}
            {then
              .map(
                (s) =>
                  `${formatForViewer(s.startsAt, viewerZone, SESSION_PATTERN)} ${s.title}`,
              )
              .join(" · ")}
          </p>
        )}
      </div>
    </Section>
  );
}
