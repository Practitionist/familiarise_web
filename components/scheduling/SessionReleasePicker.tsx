"use client";

import React from "react";
import { CalendarClock, CalendarRange, Check, CheckSquare } from "lucide-react";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toDate, type OccurrenceLike } from "@/lib/appointments/view-model";
import {
  RELEASE_ONE_WEEK_MESSAGE,
  spansPlanWeeks,
  type PlanWeekInput,
} from "@/lib/booking/release-weeks";
import {
  formatClockTime,
  formatDateLabel,
  formatWeekdayShort,
} from "@/lib/time/display";
import { cn } from "@/utils/tailwind";

/**
 * Which sessions of a booking are being released, for the reschedule
 * surfaces. Lifted out of the reschedule modal it replaced, unchanged in behaviour;
 * `TimePicker` shows it beside the grid rather than as a first step, because a
 * page has the width the dialog did not.
 */

export type ReleaseMode = "individual" | "multiple" | "entire";

export interface ReleasableSession {
  slots: OccurrenceLike[];
  startTime: Date;
  endTime: Date;
}

/**
 * The booking's live sessions, earliest first. Each occurrence is one
 * session (a subscription or class is one appointment carrying many), so a
 * released, cancelled or tombstoned row is not offered.
 */
export function groupReleasableSessions(
  slots: readonly OccurrenceLike[],
): ReleasableSession[] {
  return slots
    .filter(
      (slot) =>
        !slot.isTentative &&
        !slot.deletedAt &&
        slot.completionStatus !== "CANCELLED" &&
        slot.completionStatus !== "RESCHEDULED",
    )
    .map((slot) => ({
      slots: [slot],
      startTime: toDate(slot.startsAt),
      endTime: toDate(slot.endsAt ?? slot.startsAt),
    }))
    .filter((session) => Number.isFinite(session.startTime.getTime()))
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
}

const RELEASE_MODES: readonly ReleaseMode[] = [
  "individual",
  "multiple",
  "entire",
];

function isReleaseMode(value: string): value is ReleaseMode {
  return (RELEASE_MODES as readonly string[]).includes(value);
}

/** A session that has started never moves; with a lead, one inside it does not either. */
function isWithinLeadTime(session: ReleasableSession, minLeadHours: number) {
  return (
    (session.startTime.getTime() - Date.now()) / (1000 * 60 * 60) <
    Math.max(minLeadHours, 0)
  );
}

function SessionList({
  mode,
  sessions,
  minLeadHours,
  selectedSlotIds,
  onChange,
  zone,
  planWeek,
}: Readonly<{
  zone: string;
  mode: Exclude<ReleaseMode, "entire">;
  sessions: ReleasableSession[];
  minLeadHours: number;
  selectedSlotIds: string[];
  onChange: React.Dispatch<React.SetStateAction<string[]>>;
  planWeek?: PlanWeekInput;
}>) {
  const [crossedWeek, setCrossedWeek] = React.useState(false);
  /** The server's RELEASE_ONE_WEEK rule: a release stays inside one plan week. */
  const crossesWeek = (session: ReleasableSession) => {
    if (!planWeek) return false;
    const picked = sessions.filter((s) =>
      s.slots.every((slot) => selectedSlotIds.includes(slot.id)),
    );
    return spansPlanWeeks(planWeek, [
      ...picked.map((s) => s.startTime),
      session.startTime,
    ]);
  };
  return (
    <div className="space-y-2">
      <div className="max-h-64 space-y-2 overflow-y-auto rounded-lg border border-border p-2">
        {sessions.map((session) => {
          const sessionSlotIds = session.slots.map((s) => s.id);
          const isSelected = sessionSlotIds.every((id) =>
            selectedSlotIds.includes(id),
          );
          const locked = isWithinLeadTime(session, minLeadHours);

          const toggle = () => {
            if (locked) return;
            if (mode === "multiple" && !isSelected && crossesWeek(session)) {
              setCrossedWeek(true);
              return;
            }
            setCrossedWeek(false);
            if (mode === "individual") {
              onChange(sessionSlotIds);
            } else if (isSelected) {
              onChange((prev) =>
                prev.filter((id) => !sessionSlotIds.includes(id)),
              );
            } else {
              onChange((prev) =>
                Array.from(new Set([...prev, ...sessionSlotIds])),
              );
            }
          };

          return (
            <button
              // The sorted list reorders when subject.slots changes; the first
              // slot's id is stable across that, an index is not.
              key={sessionSlotIds[0]}
              type="button"
              onClick={toggle}
              disabled={locked}
              aria-pressed={isSelected}
              className={cn(
                "flex w-full items-center justify-between rounded-md p-2.5 text-left transition-colors",
                isSelected
                  ? "bg-primary text-primary-foreground"
                  : locked
                    ? "cursor-not-allowed bg-muted text-muted-foreground/70"
                    : "bg-muted text-foreground hover:bg-muted/80",
              )}
            >
              <div className="flex items-center gap-2">
                {mode === "multiple" && (
                  <div
                    className={cn(
                      "flex h-4 w-4 items-center justify-center rounded border",
                      isSelected
                        ? "border-primary-foreground bg-primary-foreground"
                        : locked
                          ? "border-border"
                          : "border-muted-foreground",
                    )}
                  >
                    {isSelected && <Check className="h-3 w-3 text-primary" />}
                  </div>
                )}
                <div>
                  <div className="text-sm font-medium">
                    {formatWeekdayShort(session.startTime, { zone })},{" "}
                    {formatDateLabel(session.startTime, { zone })}
                  </div>
                  <div
                    className={cn(
                      "text-xs",
                      isSelected
                        ? "text-primary-foreground/70"
                        : "text-muted-foreground",
                    )}
                  >
                    {formatClockTime(session.startTime, { zone })} &ndash;{" "}
                    {formatClockTime(session.endTime, { zone })}
                  </div>
                </div>
              </div>
              {locked && (
                <span className="rounded bg-orange-100 px-2 py-0.5 text-xs text-orange-600 dark:bg-orange-900/30 dark:text-orange-300">
                  {minLeadHours > 0 ? `Within ${minLeadHours}h` : "Started"}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {crossedWeek && (
        <p role="status" className="text-xs text-amber-700">
          {RELEASE_ONE_WEEK_MESSAGE}
        </p>
      )}
    </div>
  );
}

const MODE_OPTIONS: {
  value: ReleaseMode;
  icon: typeof CalendarClock;
  label: string;
  hint: (sessionCount: number) => string;
}[] = [
  {
    value: "individual",
    icon: CalendarClock,
    label: "One session",
    hint: () => "Only the session you pick moves.",
  },
  {
    value: "multiple",
    icon: CheckSquare,
    label: "Several sessions",
    hint: () => "Pick exactly which sessions move.",
  },
  {
    value: "entire",
    icon: CalendarRange,
    label: "Every session",
    hint: (count) => `All ${count} sessions are released.`,
  },
];

export function SessionReleasePicker({
  sessions,
  minLeadHours,
  mode,
  onModeChange,
  selectedSlotIds,
  onSelectionChange,
  zone,
  planWeek,
}: Readonly<{
  /** The zone the page draws times in, so the list matches the grid. */
  zone: string;
  /** A subscription's plan weeks; a release stays inside one of them. */
  planWeek?: PlanWeekInput;
  sessions: ReleasableSession[];
  minLeadHours: number;
  mode: ReleaseMode;
  onModeChange: (mode: ReleaseMode) => void;
  selectedSlotIds: string[];
  onSelectionChange: React.Dispatch<React.SetStateAction<string[]>>;
}>) {
  const spansWeeks =
    !!planWeek &&
    spansPlanWeeks(
      planWeek,
      sessions
        .filter((session) => !isWithinLeadTime(session, minLeadHours))
        .map((session) => session.startTime),
    );
  const handleModeChange = (next: ReleaseMode) => {
    onModeChange(next);
    if (next === "entire") {
      onSelectionChange([]);
      return;
    }
    if (next === "individual") {
      // Narrowing from "several" must leave exactly one session ticked, or the
      // submit sits disabled with every box still visibly checked.
      const alreadyPicked = sessions.find((session) =>
        session.slots.some((slot) => selectedSlotIds.includes(slot.id)),
      );
      // NOT sessions[0]: the list is earliest-first, so the first entry is the
      // one most likely to be inside the lead window — and SessionList
      // disables that row, leaving it ticked and untickable. The submit stays
      // enabled (it only counts selected ids), so the server rejects a release
      // the user cannot change.
      const target =
        alreadyPicked ??
        sessions.find((session) => !isWithinLeadTime(session, minLeadHours));
      onSelectionChange(target ? target.slots.map((s) => s.id) : []);
    }
  };

  return (
    <div className="space-y-3">
      <Label className="text-sm font-medium text-foreground">
        What is moving?
      </Label>

      <RadioGroup
        value={mode}
        onValueChange={(value) => {
          if (isReleaseMode(value)) handleModeChange(value);
        }}
        className="grid gap-2 sm:grid-cols-3"
      >
        {MODE_OPTIONS.map((option) => {
          const off = option.value === "entire" && spansWeeks;
          return (
            <div
              key={option.value}
              className={cn(
                "flex items-start gap-2 rounded-lg border p-3 transition-colors",
                mode === option.value
                  ? "border-primary bg-muted"
                  : "border-border hover:border-foreground/30",
              )}
            >
              <RadioGroupItem
                value={option.value}
                id={`release-${option.value}`}
                className="mt-1"
                disabled={off}
              />
              <Label
                htmlFor={`release-${option.value}`}
                className="flex-1 cursor-pointer"
              >
                <span className="flex items-center gap-2 font-medium text-foreground">
                  <option.icon className="h-4 w-4" />
                  {option.label}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {off
                    ? RELEASE_ONE_WEEK_MESSAGE
                    : option.hint(sessions.length)}
                </span>
              </Label>
            </div>
          );
        })}
      </RadioGroup>

      {mode !== "entire" && (
        <SessionList
          mode={mode}
          sessions={sessions}
          minLeadHours={minLeadHours}
          selectedSlotIds={selectedSlotIds}
          onChange={onSelectionChange}
          zone={zone}
          planWeek={planWeek}
        />
      )}
    </div>
  );
}
