"use client";

import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import { Badge } from "@/components/ui/badge";
import {
  buildScheduleModel,
  lengthLabel,
  timeRangeLabel,
  weekRangeLabel,
  type ScheduleSession,
} from "@/lib/appointments/session-schedule";
import {
  canonicalZone,
  zoneDisplayLabel,
  zoneLabel,
} from "@/lib/time/viewer-zone";
import { cn } from "@/utils/tailwind";
import { Button } from "@/components/ui/button";
import { useBuyerPrice } from "@/components/pricing/BuyerPriceProvider";
import { useSession } from "@/lib/auth-client";
import { NotifyMeButton } from "@/components/booking/NotifyMeButton";
import { useRefreshOnViewerChange } from "@/hooks/useRefreshOnViewerChange";
import type { BatchCard } from "@/lib/booking/batch-cards";
import {
  buildSessionsFromAppointment,
  type SessionInfo,
} from "@/app/explore/programs/plans/schedule-utils";
import type { TClassPlanDetailsData } from "../types";

type Plan = TClassPlanDetailsData;
type Batch = Plan["classes"][number];

/** #1819 — the batch's enrolment state in one sentence. */
function enrolmentLine(
  card: BatchCard,
  price: (paise: number) => string,
  when: (d: Date) => string,
  scheduled: number,
): string {
  const next = card.nextBatchStartsAt
    ? ` · next batch starts ${when(card.nextBatchStartsAt)}`
    : "";
  if (card.phase === "completed") return "This batch has finished.";
  if (card.phase === "unscheduled") return "Dates to be announced.";
  if (card.isFull) return `Sold out${next}`;
  if (card.enrolment.state !== "open") return `Enrolment closed${next}`;
  const { basePaise, remaining, N, isLateJoin } = card.enrolment;
  // The price covers the plan's N sessions; when fewer are on the calendar
  // yet, say so instead of letting the list below contradict the line.
  const placed =
    scheduled > 0 && scheduled < N ? ` (${scheduled} scheduled so far)` : "";
  return isLateJoin
    ? `Join now for ${price(basePaise)} · ${remaining} of ${N} sessions left${placed}`
    : `Join now for ${price(basePaise)} · all ${N} sessions${placed}`;
}

function seatsLine(card: BatchCard): string {
  if (card.isFull) return "No seats left";
  return card.seatsLeft === 1 ? "1 seat left" : `${card.seatsLeft} seats left`;
}

function SessionRow({
  entry,
  zone,
  showLength,
}: Readonly<{
  entry: ScheduleSession<ScheduleRow>;
  zone: string;
  showLength: boolean;
}>) {
  const { session } = entry;
  const status = session.info.status;
  const details = [
    showLength ? lengthLabel(entry.minutes) : null,
    entry.sharesDay ? "Same day as another session" : null,
  ].filter(Boolean);
  return (
    <li
      className={cn(
        "flex items-center gap-4 py-3",
        status === "Completed" && "opacity-70",
      )}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border text-xs font-semibold tabular-nums text-muted-foreground">
        {entry.number}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">
          {formatInTimeZone(session.startsAt, zone, "EEE d MMM")}
          <span className="ml-2 font-normal text-muted-foreground tabular-nums">
            {timeRangeLabel(
              (d, pattern) => formatInTimeZone(d, zone, pattern),
              session.startsAt,
              session.endsAt,
            )}
          </span>
        </p>
        {details.length > 0 && (
          <p className="text-xs text-muted-foreground">{details.join(" · ")}</p>
        )}
      </div>
      {/* Upcoming is the default and says nothing; only a finished or
          running session carries a word. */}
      {status === "Completed" && (
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            aria-hidden
            className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40"
          />
          Done
        </span>
      )}
      {status === "Happening Now" && (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
          <span
            aria-hidden
            className="h-1.5 w-1.5 rounded-full bg-emerald-500"
          />
          Live now
        </span>
      )}
    </li>
  );
}

type ScheduleRow = {
  key: string;
  startsAt: Date;
  endsAt: Date;
  info: SessionInfo;
};

function BatchSessions({
  batch,
  sessionsPerWeek,
  zone,
}: Readonly<{ batch: Batch; sessionsPerWeek: number; zone: string }>) {
  const sessions = buildSessionsFromAppointment(batch.appointment);
  if (sessions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">Schedule to be announced</p>
    );
  }
  const model = buildScheduleModel(
    sessions.map((info) => ({
      key: info.sessionStart.toISOString(),
      startsAt: info.sessionStart,
      endsAt: info.sessionEnd,
      info,
    })),
    zone,
    { sessionsPerWeek },
  );
  const row = (entry: ScheduleSession<ScheduleRow>) => (
    <SessionRow
      key={entry.session.key}
      entry={entry}
      zone={zone}
      showLength={model.mixedLengths}
    />
  );
  // One session a week makes every "Week N" heading hold a single row.
  if (sessionsPerWeek <= 1 || !model.multiWeek) {
    return (
      <ul className="divide-y divide-border/70">{model.sessions.map(row)}</ul>
    );
  }
  return (
    <div className="space-y-4">
      {model.weeks.map((week) => (
        <section key={week.week} aria-label={`Week ${week.week}`}>
          <h4 className="mb-1 flex flex-wrap items-baseline gap-x-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Week {week.week}
            <span className="font-normal normal-case tracking-normal">
              {weekRangeLabel(week.firstDay, week.lastDay)}
            </span>
            {week.sessions.length === 0 && (
              <span className="font-normal normal-case tracking-normal">
                · No sessions this week
              </span>
            )}
          </h4>
          {week.sessions.length > 0 && (
            <ul className="divide-y divide-border/70">
              {week.sessions.map(row)}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

function BatchPanel({
  plan,
  batch,
  card,
  zone,
  userId,
  enrolledAppointmentIds,
  waitingAppointmentIds,
}: Readonly<{
  plan: Plan;
  batch: Batch;
  card: BatchCard;
  zone: string;
  userId: string | undefined;
  enrolledAppointmentIds: readonly string[];
  waitingAppointmentIds: readonly string[];
}>) {
  const { formatBuyerPriceLabel } = useBuyerPrice();
  const checkoutUrl = `/checkout/plans/class/${plan.id}?eventId=${card.classId}`;
  const enrolled =
    !!userId &&
    !!batch.appointment &&
    enrolledAppointmentIds.includes(batch.appointment.id);
  const waiting =
    !!batch.appointment && waitingAppointmentIds.includes(batch.appointment.id);
  // A waiter keeps a way to leave after a seat opens and the card stops reading full.
  const canWait =
    !enrolled &&
    !!batch.appointment &&
    (waiting ||
      (card.isFull &&
        card.enrolment.state === "open" &&
        card.phase !== "completed" &&
        plan.waitlistEnabled));
  const href = userId
    ? checkoutUrl
    : `/auth/signin?callbackUrl=${encodeURIComponent(checkoutUrl)}`;
  return (
    <div className="space-y-4 rounded-2xl border border-border/80 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="font-medium text-foreground">{card.label}</h3>
          <p className="text-sm text-muted-foreground">
            {enrolmentLine(
              card,
              formatBuyerPriceLabel,
              (d) => formatInTimeZone(d, zone, "EEE d MMM"),
              buildSessionsFromAppointment(batch.appointment).length,
            )}
          </p>
          {card.phase !== "completed" && (
            <p className="text-sm text-muted-foreground">{seatsLine(card)}</p>
          )}
          {card.freeCancellationUntil && (card.canEnrol || enrolled) && (
            <p className="text-sm text-muted-foreground">
              Free cancellation until{" "}
              {formatInTimeZone(
                card.freeCancellationUntil,
                zone,
                "EEE d MMM, h:mm a",
              )}{" "}
              {zoneLabel(card.freeCancellationUntil, zone)}.
            </p>
          )}
        </div>
        {enrolled && <Badge variant="secondary">You are enrolled</Badge>}
        {canWait && batch.appointment && (
          <NotifyMeButton
            kind="CLASS"
            eventId={card.classId}
            waiting={waiting}
            signedIn={!!userId}
            compact
          />
        )}
        {!enrolled && card.canEnrol && (
          <Button asChild size="sm">
            <Link href={href}>Enrol in this batch</Link>
          </Button>
        )}
      </div>
      {card.startsAt && (
        <p
          className="text-xs text-muted-foreground"
          title={canonicalZone(zone)}
        >
          Times in {zoneDisplayLabel(card.startsAt, zone)}
        </p>
      )}
      <BatchSessions
        batch={batch}
        sessionsPerWeek={plan.sessionsPerWeek}
        zone={zone}
      />
    </div>
  );
}

/** #1819 — the listing's batches as cards, finished batches collapsed. */
export function BatchSchedule({
  plan,
  cards,
  zone,
  enrolledAppointmentIds,
  waitingAppointmentIds,
  viewerUserId,
}: Readonly<{
  plan: Plan;
  cards: BatchCard[];
  zone: string;
  enrolledAppointmentIds: readonly string[];
  waitingAppointmentIds: readonly string[];
  viewerUserId: string | null;
}>) {
  useRefreshOnViewerChange(viewerUserId);
  const { data: session } = useSession();
  const userId = session?.user?.id;
  const byId = new Map(plan.classes.map((c) => [c.id, c]));
  const panel = (card: BatchCard) => {
    const batch = byId.get(card.classId);
    return batch ? (
      <BatchPanel
        key={card.classId}
        plan={plan}
        batch={batch}
        card={card}
        zone={zone}
        userId={userId}
        enrolledAppointmentIds={enrolledAppointmentIds}
        waitingAppointmentIds={waitingAppointmentIds}
      />
    ) : null;
  };
  const current = cards.filter((c) => c.phase !== "completed");
  const past = cards.filter((c) => c.phase === "completed");
  if (cards.length === 0) {
    return (
      <p className="text-muted-foreground">Class schedule to be announced.</p>
    );
  }
  return (
    <div className="space-y-6">
      {current.map(panel)}
      {past.length > 0 && (
        <details className="rounded-xl border border-border p-4">
          <summary className="cursor-pointer text-sm font-medium text-foreground">
            Past batches ({past.length})
          </summary>
          <div className="mt-4 space-y-6">{past.map(panel)}</div>
        </details>
      )}
    </div>
  );
}
