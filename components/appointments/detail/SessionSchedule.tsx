"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronDown, Loader2, MoreHorizontal, Video } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ZoneSwitch } from "@/components/scheduling/ZoneSwitch";
import { useNowTick } from "@/hooks/use-now-tick";
import {
  CONSULTEE_JOIN_WINDOW_MS,
  DEFAULT_MEETING_DURATION_MS,
  isDeadOccurrence,
} from "@/lib/appointments/occurrences";
import {
  buildScheduleModel,
  lengthLabel,
  timeRangeLabel,
  weekRangeLabel,
  type ScheduleSession,
} from "@/lib/appointments/session-schedule";
import type { OccurrenceVM } from "@/lib/appointments/view-model";
import { useDisplayZone } from "@/lib/time/use-display-zone";
import {
  DisplayZoneProvider,
  useProvidedZone,
  useZonedFormat,
} from "@/lib/time/zoned-format";
import { cn } from "@/utils/tailwind";

import { CountdownBadge } from "../CountdownBadge";
import { slotStatus } from "../SessionTimeline";

/** One thing a viewer can do to a single session, offered on its row. */
export interface SessionRowAction {
  key: string;
  label: string;
  onSelect: () => void;
  /** A page the action opens; the inline entry is then a real link. */
  href?: string;
  disabled?: boolean;
  /** Why the action is unavailable, in words; shown under the label in the menu. */
  blockedBecause?: string;
  destructive?: boolean;
}

type RowStatus = ReturnType<typeof slotStatus>;

/** A row's first action beside the session, visible at rest at every width; a link when it opens a page. */
export function InlineRowAction({
  action,
}: Readonly<{ action: SessionRowAction }>) {
  if (action.href) {
    return (
      <Button variant="ghost" size="sm" className="h-8" asChild>
        <Link href={action.href}>{action.label}</Link>
      </Button>
    );
  }
  return (
    <Button variant="ghost" size="sm" className="h-8" onClick={action.onSelect}>
      {action.label}
    </Button>
  );
}

/**
 * Upcoming is the default and says nothing; only states a reader must notice
 * carry a word, and only the exceptions carry colour.
 */
const STATUS_TEXT: Partial<Record<RowStatus, string>> = {
  completed: "Done",
  cutShort: "Cut short",
  noShow: "No-show",
  inconclusive: "Verifying",
  noRecord: "No record",
  joinable: "Live now",
};

const STATUS_DOT: Partial<Record<RowStatus, string>> = {
  completed: "bg-muted-foreground/40",
  cutShort: "bg-amber-500",
  noShow: "bg-amber-500",
  inconclusive: "bg-sky-500",
  noRecord: "bg-amber-500",
  joinable: "bg-emerald-500",
};

const STATUS_TITLE: Partial<Record<RowStatus, string>> = {
  cutShort: "This session ended earlier than the scheduled duration.",
  noShow: "One or more participants did not attend this session.",
  inconclusive: "Session attendance is being verified.",
  noRecord:
    "No meeting record found for this session. It may have been missed or held outside the platform.",
  joinable:
    "This session's time has arrived, but it cannot be joined from here.",
};

const PAST: ReadonlySet<RowStatus> = new Set([
  "completed",
  "cutShort",
  "noShow",
  "inconclusive",
  "noRecord",
]);

interface SessionScheduleProps {
  occurrences: OccurrenceVM[];
  joinWindowMs?: number;
  isJoining?: boolean;
  /** Absent ⇒ rows never offer Join. */
  onJoinSession?: (session: OccurrenceVM) => void;
  /** Past rows only: the rating or attendance beside a session that ran. */
  renderSessionExtra?: (session: OccurrenceVM) => ReactNode;
  /** Schedule words for a held (unpaid) session, e.g. "Held · 4d". */
  heldRowLabel?: (session: OccurrenceVM) => string;
  /** Per-session actions; the first enabled non-destructive one also shows inline. */
  rowActions?: (session: OccurrenceVM) => SessionRowAction[];
  /** The plan's weekly count, so a week with fewer sessions is called out. */
  sessionsPerWeek?: number | null;
  /** The viewer's profile zone; null hides the zone line. */
  profileZone?: string | null;
  /** Rendered under the list, e.g. a rule the row actions follow. */
  footnote?: ReactNode;
  /** A cancelled session's state ("make-up owed"); a non-null note keeps the row listed. */
  cancelledNote?: (session: OccurrenceVM) => string | null;
}

/**
 * Every session of a booking in one list: held sessions first, past sessions
 * folded behind a disclosure, upcoming sessions grouped by week when the
 * schedule spans weeks. Each row is a day tile, the time range, a quiet
 * status and its own actions, so no second list repeats the dates.
 */
export function SessionSchedule(props: Readonly<SessionScheduleProps>) {
  const provided = useProvidedZone();
  const profileZone = props.profileZone ?? provided;
  const display = useDisplayZone(profileZone);
  const body = <ScheduleBody {...props} zone={display.zone} />;
  return (
    <div className="space-y-3">
      {profileZone && (
        <ZoneSwitch
          zone={display.zone}
          usingDeviceZone={display.usingDeviceZone}
          canSwitch={display.canSwitch}
          onToggle={display.toggle}
          now={props.occurrences[0]?.startsAt}
        />
      )}
      {display.usingDeviceZone ? (
        <DisplayZoneProvider zone={display.zone}>{body}</DisplayZoneProvider>
      ) : (
        body
      )}
    </div>
  );
}

type Row = { key: string; startsAt: Date; endsAt: Date; vm: OccurrenceVM };

function toRow(vm: OccurrenceVM): Row {
  return {
    key: vm.occurrenceId,
    startsAt: vm.startsAt,
    endsAt:
      vm.endsAt ??
      new Date(vm.startsAt.getTime() + DEFAULT_MEETING_DURATION_MS),
    vm,
  };
}

function ScheduleBody({
  occurrences,
  joinWindowMs = CONSULTEE_JOIN_WINDOW_MS,
  isJoining = false,
  onJoinSession,
  renderSessionExtra,
  heldRowLabel,
  rowActions,
  sessionsPerWeek,
  footnote,
  cancelledNote,
  zone,
}: Readonly<SessionScheduleProps & { zone: string }>) {
  const format = useZonedFormat();
  const now = useNowTick();
  const [showPast, setShowPast] = useState(false);

  const noteOf = (s: OccurrenceVM) =>
    isDeadOccurrence(s) ? (cancelledNote?.(s) ?? null) : null;
  // A cancelled session the viewer must still read stays in the schedule.
  const live = useMemo(
    () =>
      occurrences.filter((s) => !isDeadOccurrence(s) || !!cancelledNote?.(s)),
    [occurrences, cancelledNote],
  );
  const held = live
    .filter((s) => s.isTentative && !isDeadOccurrence(s))
    .map(toRow);
  const model = useMemo(
    () =>
      buildScheduleModel(
        live.filter((s) => !s.isTentative || isDeadOccurrence(s)).map(toRow),
        zone,
        {
          sessionsPerWeek,
          counts: (row) => !isDeadOccurrence(row.vm),
        },
      ),
    [live, zone, sessionsPerWeek],
  );

  const statusOf = (s: ScheduleSession<Row>) =>
    slotStatus(s.session.vm, joinWindowMs, now);
  const past = model.sessions.filter((s) => PAST.has(statusOf(s)));
  const ahead = model.sessions.filter((s) => !PAST.has(statusOf(s)));
  const nextKey = ahead.find(
    (s) => statusOf(s) === "upcoming" && !noteOf(s.session.vm),
  )?.session.key;
  const aheadKeys = new Set(ahead.map((s) => s.session.key));
  // Weeks are listed from the first one still ahead, empty weeks included,
  // so a gap in the schedule is visible rather than silently skipped.
  const firstAheadWeek =
    model.weeks.find((w) =>
      w.sessions.some((s) => aheadKeys.has(s.session.key)),
    )?.week ?? Infinity;

  if (model.sessions.length === 0 && held.length === 0) return null;

  const renderRow = (s: ScheduleSession<Row>) => (
    <SessionRow
      key={s.session.key}
      entry={s}
      status={statusOf(s)}
      isNext={s.session.key === nextKey}
      showLength={model.mixedLengths}
      isJoining={isJoining}
      onJoinSession={onJoinSession}
      renderSessionExtra={renderSessionExtra}
      actions={rowActions?.(s.session.vm) ?? []}
      cancelledNote={noteOf(s.session.vm)}
      format={format}
      now={now}
    />
  );

  return (
    <div className="space-y-4">
      {held.length > 0 && (
        <ul className="divide-y divide-amber-200/70 overflow-hidden rounded-xl border border-amber-200 bg-amber-50/60 dark:divide-amber-900/40 dark:border-amber-900/40 dark:bg-amber-950/20">
          {held.map((row) => {
            const label = heldRowLabel ? heldRowLabel(row.vm) : "Held";
            return (
              <li key={row.key} className="flex items-center gap-4 px-4 py-3">
                <DayTile date={row.startsAt} format={format} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground tabular-nums">
                    <span className="sr-only">
                      {format(row.startsAt, "EEEE d MMMM")},{" "}
                    </span>
                    {timeRangeLabel(format, row.startsAt, row.endsAt)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {label.startsWith("Held")
                      ? "Held for this booking"
                      : "Was held for this booking"}
                  </p>
                </div>
                <span className="text-xs font-medium text-amber-800 dark:text-amber-300">
                  {label}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {past.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowPast((v) => !v)}
            aria-expanded={showPast}
            className="flex w-full items-center gap-2 rounded-md py-1 text-left text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 transition-transform",
                showPast && "rotate-180",
              )}
            />
            {showPast
              ? "Hide past sessions"
              : `${past.length} past ${past.length === 1 ? "session" : "sessions"}`}
          </button>
          {showPast && (
            <ul className="mt-1 divide-y divide-border/70">
              {past.map(renderRow)}
            </ul>
          )}
        </div>
      )}

      {ahead.length > 0 &&
        (model.multiWeek ? (
          <div className="space-y-4">
            {model.weeks
              .filter((w) => w.week >= firstAheadWeek)
              .map((w) => {
                const rows = w.sessions.filter((s) =>
                  aheadKeys.has(s.session.key),
                );
                return (
                  <section key={w.week} aria-label={`Week ${w.week}`}>
                    <h3 className="mb-1 flex flex-wrap items-baseline gap-x-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Week {w.week}
                      <span className="font-normal normal-case tracking-normal">
                        {weekRangeLabel(w.firstDay, w.lastDay)}
                      </span>
                      {w.sessions.length === 0 ? (
                        <span className="font-normal normal-case tracking-normal text-amber-700 dark:text-amber-400">
                          · No sessions this week
                        </span>
                      ) : w.short && sessionsPerWeek ? (
                        <span className="font-normal normal-case tracking-normal text-amber-700 dark:text-amber-400">
                          · {w.counted} of {sessionsPerWeek} this week
                        </span>
                      ) : null}
                    </h3>
                    {rows.length > 0 && (
                      <ul className="divide-y divide-border/70">
                        {rows.map(renderRow)}
                      </ul>
                    )}
                  </section>
                );
              })}
          </div>
        ) : (
          <ul className="divide-y divide-border/70">{ahead.map(renderRow)}</ul>
        ))}

      {footnote}
    </div>
  );
}

function DayTile({
  date,
  format,
}: Readonly<{ date: Date; format: (d: Date, p: string) => string }>) {
  return (
    <div
      aria-hidden
      className="flex w-11 shrink-0 flex-col items-center rounded-lg border border-border bg-background py-1 leading-none"
    >
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {format(date, "EEE")}
      </span>
      <span className="mt-0.5 text-base font-semibold tabular-nums text-foreground">
        {format(date, "d")}
      </span>
      <span className="mt-0.5 text-[10px] uppercase text-muted-foreground">
        {format(date, "MMM")}
      </span>
    </div>
  );
}

function SessionRow({
  entry,
  status,
  isNext,
  showLength,
  isJoining,
  onJoinSession,
  renderSessionExtra,
  actions,
  cancelledNote,
  format,
  now,
}: Readonly<{
  entry: ScheduleSession<Row>;
  cancelledNote: string | null;
  status: RowStatus;
  isNext: boolean;
  showLength: boolean;
  isJoining: boolean;
  onJoinSession?: (session: OccurrenceVM) => void;
  renderSessionExtra?: (session: OccurrenceVM) => ReactNode;
  actions: SessionRowAction[];
  format: (d: Date, p: string) => string;
  now: Date;
}>) {
  const { session: row } = entry;
  const cancelled = cancelledNote !== null;
  const canJoin = !cancelled && status === "joinable" && !!onJoinSession;
  const inline = actions.find((a) => !a.destructive && !a.disabled);
  const isPast = !cancelled && PAST.has(status);
  const details = [
    `Session ${entry.number}`,
    showLength ? lengthLabel(entry.minutes) : null,
    entry.sharesDay ? "Same day as another session" : null,
    cancelledNote,
  ].filter(Boolean);

  return (
    <li
      className={cn(
        "group flex flex-wrap items-center gap-x-4 gap-y-2 py-3",
        isPast && status === "completed" && "opacity-75",
      )}
    >
      <DayTile date={row.startsAt} format={format} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground tabular-nums">
          {/* The day tile is decorative; this names the date to a screen reader. */}
          <span className="sr-only">
            {format(row.startsAt, "EEEE d MMMM")},{" "}
          </span>
          {timeRangeLabel(format, row.startsAt, row.endsAt)}
        </p>
        <p className="text-xs text-muted-foreground">{details.join(" · ")}</p>
      </div>

      {isPast && renderSessionExtra?.(row.vm)}

      <div className="flex items-center gap-2">
        {canJoin ? (
          <Button
            size="sm"
            className="h-8 bg-emerald-600 text-white hover:bg-emerald-700"
            disabled={isJoining}
            onClick={() => onJoinSession?.(row.vm)}
          >
            {isJoining ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Video className="mr-1.5 h-3.5 w-3.5" />
            )}
            {now.getTime() > row.startsAt.getTime() ? "Rejoin" : "Join"}
          </Button>
        ) : cancelled ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              aria-hidden
              className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40"
            />
            Cancelled
          </span>
        ) : isNext ? (
          <CountdownBadge
            targetDate={row.startsAt}
            sessionEndDate={row.endsAt}
          />
        ) : STATUS_TEXT[status] ? (
          <span
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
            title={STATUS_TITLE[status]}
          >
            <span
              aria-hidden
              className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT[status])}
            />
            {STATUS_TEXT[status]}
          </span>
        ) : null}

        {inline && <InlineRowAction action={inline} />}
        {actions.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label={`Actions for the ${format(row.startsAt, "EEE d MMM, h:mm a")} session`}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              {actions.map((a) => (
                <DropdownMenuItem
                  key={a.key}
                  disabled={a.disabled}
                  onSelect={a.onSelect}
                  className={cn(
                    "flex flex-col items-start gap-0.5",
                    a.destructive &&
                      "text-red-600 focus:text-red-700 dark:text-red-400",
                  )}
                >
                  <span>{a.label}</span>
                  {a.disabled && a.blockedBecause && (
                    <span className="text-xs text-muted-foreground">
                      {a.blockedBecause}
                    </span>
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </li>
  );
}
