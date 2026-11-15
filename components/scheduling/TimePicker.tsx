"use client";

import { earliestWeekSessions } from "@/lib/booking/release-weeks";
import { MobileAutoSchedule } from "./MobileAutoSchedule";
import { rescheduleWindow } from "@/lib/booking/entitlement";
import {
  isShortNotice,
  leadMsFor,
  RESCHEDULE_MIN_LEAD_HOURS,
} from "@/lib/booking/lead-time";
import React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DesktopOnlyNotice } from "@/components/scheduling/DesktopOnlyNotice";
import { MobileDayListPicker } from "@/components/scheduling/MobileDayListPicker";
import { SafeUnifiedCalendar } from "@/components/scheduling/SafeUnifiedCalendar";
import { CalendarGridSkeleton } from "@/components/scheduling/CalendarSkeletons";
import {
  groupReleasableSessions,
  SessionReleasePicker,
  type ReleaseMode,
} from "@/components/scheduling/SessionReleasePicker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  acceptsSlotPreference,
  type TimePickerPolicy,
  type TimePickerSubject,
  type SlotPreference,
} from "@/components/scheduling/time-picker-policy";
import {
  resolveFocusTarget,
  type TimePickerFocus,
} from "@/lib/scheduling/time-picker-focus";
import { useDisplayZone } from "@/lib/time/use-display-zone";
import { useViewerZone } from "@/lib/time/use-viewer-zone";
import { ZoneSwitch } from "@/components/scheduling/ZoneSwitch";
import {
  SchedulingContextBar,
  type ContextChip,
} from "@/components/scheduling/SchedulingContextBar";
import { isReleasedForReschedule } from "@/utils/scheduling-engine/types";
import { maxSessionsPerDayFor } from "@/utils/scheduling-engine/sessionCaps";
import { cn } from "@/utils/tailwind";
import { createSubmissionKeys } from "@/lib/api/submission-key";

/**
 * The one surface for choosing times, shared by allocation, both reschedule
 * roles, incident rebooking and a consultant's own event timings. Differences
 * live in the policy object (`time-picker-policy.ts`), not in branches here.
 *
 * Picking one or a few times works on any screen: below `md` the heat map is
 * replaced by a day list fed by the same endpoint, and the release step and
 * the footer ("Any time works", submit) are always reachable. Only allocation
 * and manage-timings keep the week grid desktop-only.
 */

/** Radix treats "" as "clear", so "no preference" needs a real value. */
const NO_PREFERENCE = "ANY";

const TIME_OF_DAY_OPTIONS = [
  { value: NO_PREFERENCE, label: "Any time of day" },
  { value: "MORNING", label: "Mornings" },
  { value: "AFTERNOON", label: "Afternoons" },
  { value: "EVENING", label: "Evenings" },
] as const;

const DAYS_OPTIONS = [
  { value: NO_PREFERENCE, label: "Any day" },
  { value: "WEEKDAYS", label: "Weekdays" },
  { value: "WEEKENDS", label: "Weekends" },
] as const;

type TimeOfDay = NonNullable<SlotPreference["preferredTimeOfDay"]>;
type PreferredDays = NonNullable<SlotPreference["preferredDays"]>;

function isTimeOfDay(value: string): value is TimeOfDay {
  return value === "MORNING" || value === "AFTERNOON" || value === "EVENING";
}

function isPreferredDays(value: string): value is PreferredDays {
  return value === "WEEKDAYS" || value === "WEEKENDS";
}

const ATOM_MS = 30 * 60 * 1000;

/** Whole-session picks as the half-hour list the reschedule API expects. */
function atomsOf(
  picks: readonly { startsAt: string; endsAt: string }[],
): { startsAt: string; endsAt: string }[] {
  return picks.flatMap((pick) => {
    const atoms: { startsAt: string; endsAt: string }[] = [];
    const endMs = new Date(pick.endsAt).getTime();
    for (
      let at = new Date(pick.startsAt).getTime();
      at < endMs;
      at += ATOM_MS
    ) {
      atoms.push({
        startsAt: new Date(at).toISOString(),
        endsAt: new Date(at + ATOM_MS).toISOString(),
      });
    }
    return atoms;
  });
}

/**
 * Which picker a select-mode surface shows, decided once on mount: switching
 * mid-task would throw away the picks the other picker holds.
 */
function useWideViewport(): boolean | null {
  const [wide, setWide] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    setWide(window.matchMedia("(min-width: 768px)").matches);
  }, []);
  return wide;
}

/** Every disabled state names its fix. */
function submitButtonTitle(state: {
  isSubmitting: boolean;
  blocked: boolean;
  selectionIncomplete: boolean;
  pickedTimes: number;
  neededTimes: number;
  allowReleaseWithoutTime: boolean;
}): string {
  if (state.isSubmitting) {
    return "Submitting — wait for the current attempt to finish.";
  }
  if (state.blocked) {
    return "This booking's own sessions didn't load. Try again before submitting.";
  }
  if (state.selectionIncomplete) {
    return state.allowReleaseWithoutTime
      ? "Choose which sessions are moving, or choose Any time works."
      : "Choose which sessions are moving.";
  }
  if (state.pickedTimes === 0) {
    return "Pick at least one new time first.";
  }
  if (state.pickedTimes !== state.neededTimes) {
    return `Pick one new time for each session you're moving (${state.pickedTimes} of ${state.neededTimes}).`;
  }
  return "Submit the picked times.";
}

export interface TimePickerProps {
  policy: TimePickerPolicy;
  subject: TimePickerSubject;
  /** A submit is in flight; the policy's owner knows, this component does not. */
  isSubmitting?: boolean;
  /** Back out. Also wired to the allocate grid's own Cancel button. */
  onCancel?: () => void;
  className?: string;
  /** A caller-pinned instant that outranks the resolved focus. */
  focusAt?: Date;
  /** The viewer's zone from the page; the session hook supplies it otherwise. */
  viewerZone?: string | null;
  /** The request changed under this tab: reload the subject in place. */
  onRequestRefresh?: () => void;
  /** Facts the page knows about what is being scheduled, for the context row. */
  contextChips?: readonly ContextChip[];
  /** Plan-level warnings for the session tray (feasibility). */
  warnings?: string[];
}

export function TimePicker({
  policy,
  subject,
  isSubmitting = false,
  onCancel,
  className,
  focusAt,
  viewerZone,
  onRequestRefresh,
  contextChips,
  warnings,
}: Readonly<TimePickerProps>) {
  const sessionViewer = useViewerZone();
  const gridViewerZone =
    viewerZone ?? (sessionViewer.own ? sessionViewer.zone : null);
  // One zone for the grid, the day list and the release list on this page.
  const display = useDisplayZone(gridViewerZone);
  const listZone = display.zone;
  const sessions = React.useMemo(
    () => groupReleasableSessions(subject.slots ?? []),
    [subject.slots],
  );
  // On a fresh request the subject's own holds are the times the client asked for.
  const requestedSlots = React.useMemo(
    () =>
      policy.kind === "ALLOCATE"
        ? (subject.slots ?? []).filter(
            (slot) =>
              slot.isTentative &&
              !slot.deletedAt &&
              !isReleasedForReschedule(slot),
          )
        : undefined,
    [policy.kind, subject.slots],
  );

  // Pinned to this mount so the grid does not drift under an open tab.
  const [openedAt] = React.useState(() => new Date());
  const focus = React.useMemo<TimePickerFocus>(
    () =>
      focusAt
        ? { at: focusAt, precision: "session" }
        : resolveFocusTarget(subject, openedAt),
    [focusAt, subject, openedAt],
  );

  // A subscription whose sessions span two plan weeks starts with the next
  // week's sessions picked: a release moves one week at a time.
  const [initialRelease] = React.useState(() => {
    const plan = subject.rescheduleEntitlement;
    const upcoming = sessions.filter((s) => s.startTime.getTime() > Date.now());
    const firstWeek = plan ? earliestWeekSessions(plan, upcoming) : upcoming;
    return firstWeek.length < upcoming.length
      ? {
          mode: (firstWeek.length === 1
            ? "individual"
            : "multiple") as ReleaseMode,
          slotIds: firstWeek.flatMap((s) => s.slots.map((slot) => slot.id)),
        }
      : { mode: "entire" as ReleaseMode, slotIds: [] as string[] };
  });
  const [releaseMode, setReleaseMode] = React.useState<ReleaseMode>(
    initialRelease.mode,
  );
  const [selectedSlotIds, setSelectedSlotIds] = React.useState<string[]>(
    initialRelease.slotIds,
  );
  const [proposedSlots, setProposedSlots] = React.useState<
    { startsAt: string; endsAt: string }[]
  >([]);
  const [mobilePicks, setMobilePicks] = React.useState<
    { startsAt: string; endsAt: string }[]
  >([]);
  const [timeOfDay, setTimeOfDay] = React.useState<string>(NO_PREFERENCE);
  const [days, setDays] = React.useState<string>(NO_PREFERENCE);
  const [blocked, setBlocked] = React.useState(false);

  const isSelectMode = policy.calendarMode === "select";
  const wide = useWideViewport();
  const useDayList = isSelectMode && wide === false;

  /** A one-session booking has nothing to choose between. */
  const showReleaseStep = policy.showReleasedSlots && sessions.length > 1;
  const picksSpecificSessions = showReleaseStep && releaseMode !== "entire";
  const selectionIncomplete =
    picksSpecificSessions && selectedSlotIds.length === 0;
  const releasedOccurrenceIds = picksSpecificSessions
    ? selectedSlotIds
    : /* Every session; the API reads an absent list as "all of them". */
      undefined;

  const selectedSessionCount = React.useMemo(
    () =>
      sessions.filter((session) =>
        session.slots.every((slot) => selectedSlotIds.includes(slot.id)),
      ).length,
    [sessions, selectedSlotIds],
  );

  /** How many times to ask for, so the hint matches what is actually moving. */
  const sessionsBeingMoved = picksSpecificSessions
    ? Math.max(selectedSessionCount, 1)
    : Math.max(sessions.length, 1);

  // The clock the short-notice rule reads; the focus above stays pinned.
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  React.useEffect(() => {
    const tick = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(tick);
  }, []);
  // A session under 24 hours away moves only with named times the other side accepts.
  const movingShortNotice = React.useMemo(() => {
    const moving = picksSpecificSessions
      ? sessions.filter((session) =>
          session.slots.every((slot) => selectedSlotIds.includes(slot.id)),
        )
      : sessions;
    return moving.some(
      (session) =>
        session.startTime.getTime() > nowMs &&
        isShortNotice(session.startTime.getTime(), nowMs),
    );
  }, [picksSpecificSessions, sessions, selectedSlotIds, nowMs]);
  const offersAnyTime = policy.allowReleaseWithoutTime && !movingShortNotice;

  /** Group events never reach the proposal path, so they state no preference. */
  const canStatePreference =
    offersAnyTime && acceptsSlotPreference(subject.eventType);

  const preference = (): SlotPreference | undefined => {
    if (!canStatePreference) return undefined;
    const stated: SlotPreference = {
      ...(isTimeOfDay(timeOfDay) && { preferredTimeOfDay: timeOfDay }),
      ...(isPreferredDays(days) && { preferredDays: days }),
    };
    return Object.keys(stated).length > 0 ? stated : undefined;
  };

  const slotsPerSession = Math.ceil(
    (subject.sessionDurationInHours || subject.durationInHours || 1) / 0.5,
  );
  const picked = useDayList ? atomsOf(mobilePicks) : proposedSlots;
  const requiredProposedSlots = sessionsBeingMoved * slotsPerSession;
  const pickedTimes = Math.floor(picked.length / slotsPerSession);

  const [submissionKeyFor] = React.useState(createSubmissionKeys);
  const submit = (withTimes: boolean) => {
    if (isSubmitting) return;
    const named = withTimes && picked.length > 0;
    const request = {
      slotIds: releasedOccurrenceIds,
      proposedSlots: named ? picked : undefined,
      preference: named ? undefined : preference(),
    };
    void policy.onSubmit({
      ...request,
      displayZone: listZone,
      idempotencyKey: submissionKeyFor(request),
    });
  };

  /** The occurrences this submit would release, for the plan-limit overlay. */
  const releasingIds = React.useMemo(() => {
    if (!isSelectMode || !policy.showReleasedSlots) return undefined;
    const moving = picksSpecificSessions
      ? sessions.filter((session) =>
          session.slots.every((slot) => selectedSlotIds.includes(slot.id)),
        )
      : sessions;
    return moving.flatMap((session) => session.slots.map((slot) => slot.id));
  }, [
    isSelectMode,
    policy.showReleasedSlots,
    picksSpecificSessions,
    sessions,
    selectedSlotIds,
  ]);
  const isRecurring =
    subject.eventType === "subscription" || subject.eventType === "class";
  const dayCap = React.useMemo(
    () =>
      isRecurring
        ? {
            perDay: maxSessionsPerDayFor(
              subject.eventType === "class" ? "class" : "subscription",
            ),
            zone: subject.schedulingTimezone ?? listZone,
          }
        : undefined,
    [isRecurring, subject.eventType, subject.schedulingTimezone, listZone],
  );

  // A subscription move may only target the plan week the server would place
  // into once these sessions are released; outside it the pick is dropped.
  const allowed = React.useMemo((): { start?: Date; end?: Date } => {
    const input = subject.rescheduleEntitlement;
    if (!input || !releasingIds) {
      return { start: subject.allowedStart, end: subject.allowedEnd };
    }
    return rescheduleWindow(input, releasingIds);
  }, [subject, releasingIds]);
  const showConsultantLegend =
    policy.kind === "RESCHEDULE_CONSULTANT" ||
    policy.kind === "MANAGE_TIMINGS" ||
    policy.kind === "ALLOCATE";

  const handleSlotsSelected = React.useCallback(
    (slots: { startTime: Date; endTime: Date }[]) =>
      setProposedSlots(
        slots.map((slot) => ({
          startsAt: slot.startTime.toISOString(),
          endsAt: slot.endTime.toISOString(),
        })),
      ),
    [],
  );
  const handleAllocationComplete = React.useCallback(
    () => void policy.onSubmit({}),
    [policy],
  );

  const zoneLine = (
    <ZoneSwitch
      className="shrink-0"
      zone={display.zone}
      usingDeviceZone={display.usingDeviceZone}
      canSwitch={display.canSwitch}
      onToggle={display.toggle}
    />
  );
  const gridContextChips = React.useMemo<ContextChip[]>(
    () => [
      ...(policy.showReleasedSlots
        ? [
            {
              key: "notice",
              label: "Moves",
              value: `within ${RESCHEDULE_MIN_LEAD_HOURS} h only if accepted · not refunded`,
              title: `A move from or to a time within ${RESCHEDULE_MIN_LEAD_HOURS} hours happens only if the other person accepts it at least 15 minutes before the session starts. Rescheduling is not refunded.`,
            },
          ]
        : []),
      ...(contextChips ?? []),
    ],
    [policy.showReleasedSlots, contextChips],
  );

  const grid = (
    <SafeUnifiedCalendar
      className="min-h-0 flex-1"
      consultantId={subject.consultantProfileId}
      eventType={subject.eventType}
      eventId={subject.eventId}
      consulteeUserId={subject.counterpartUserId}
      mode={policy.calendarMode}
      showConsultantLegend={showConsultantLegend}
      sessionDurationInHours={subject.sessionDurationInHours}
      durationInHours={subject.durationInHours}
      sessionsPerWeek={subject.sessionsPerWeek}
      durationInMonths={subject.durationInMonths}
      totalSessions={isSelectMode ? sessionsBeingMoved : subject.totalSessions}
      schedulingTimezone={subject.schedulingTimezone}
      allowedStart={allowed.start}
      allowedEnd={allowed.end}
      // A starting position only; re-aiming while someone reads is worse.
      focus={focus}
      viewerZone={listZone}
      showZoneSwitch={false}
      zoneSlot={zoneLine}
      contextChips={gridContextChips}
      warnings={warnings}
      requestedSlots={requestedSlots}
      releasingOccurrenceIds={releasingIds}
      lead={policy.lead}
      // Fresh allocations only: a partial reschedule keeps confirmed slots.
      initialAllocation={
        policy.appliesInitialAllocationGuard
          ? !subject.hasReleasedSlots
          : undefined
      }
      // On a reschedule, pin the tentative count so a stale tab refuses.
      expectedTentativeSlotCount={
        subject.hasReleasedSlots
          ? (subject.slots?.filter((s) => s.isTentative).length ?? 0)
          : undefined
      }
      showAllocationButtons={!isSelectMode}
      onSlotsSelected={handleSlotsSelected}
      onAllocationComplete={handleAllocationComplete}
      onAllocationConflict={policy.onConflict}
      onRequestRefresh={onRequestRefresh}
      onBlockingIssueChange={setBlocked}
      onClose={onCancel}
    />
  );

  const picker = (() => {
    // The device zone is read on mount, in the same commit as the viewport.
    if (wide === null) {
      return <CalendarGridSkeleton className="min-h-0 flex-1" />;
    }
    if (!isSelectMode) {
      return (
        <DesktopOnlyNotice
          className="min-h-0 flex-1 gap-4"
          mobileAction={
            policy.kind === "ALLOCATE" &&
            subject.eventId &&
            (subject.eventType === "subscription" ||
              subject.eventType === "consultation") ? (
              <MobileAutoSchedule
                eventType={subject.eventType}
                eventId={subject.eventId}
                initialAllocation={!subject.hasReleasedSlots}
                topUp={
                  subject.eventType === "subscription" &&
                  !subject.hasReleasedSlots &&
                  (subject.slots ?? []).some((slot) => !slot.isTentative)
                }
                onDone={handleAllocationComplete}
              />
            ) : undefined
          }
        >
          {grid}
        </DesktopOnlyNotice>
      );
    }
    if (useDayList) {
      return (
        <MobileDayListPicker
          className="min-h-0 flex-1"
          consultantId={subject.consultantProfileId}
          consulteeUserId={subject.counterpartUserId}
          subscriptionId={
            subject.eventType === "subscription" ? subject.eventId : undefined
          }
          releasingIds={releasingIds}
          dayCap={dayCap}
          zone={listZone}
          sessionMinutes={slotsPerSession * 30}
          timesNeeded={sessionsBeingMoved}
          allowedStart={allowed.start}
          allowedEnd={allowed.end}
          minLeadHours={
            leadMsFor(policy.lead.purpose, {
              settled: policy.lead.unpaid !== true,
            }) / 3_600_000
          }
          focusAt={focus.precision === "session" ? focus.at : undefined}
          value={mobilePicks}
          onChange={setMobilePicks}
        />
      );
    }
    return grid;
  })();

  return (
    <div className={cn("flex min-h-0 flex-col gap-4", className)}>
      {showReleaseStep && (
        <div className="shrink-0">
          <SessionReleasePicker
            sessions={sessions}
            minLeadHours={policy.minLeadHours}
            mode={releaseMode}
            onModeChange={setReleaseMode}
            selectedSlotIds={selectedSlotIds}
            onSelectionChange={setSelectedSlotIds}
            zone={listZone}
          />
        </div>
      )}

      <p className="shrink-0 text-sm text-muted-foreground">
        {isSelectMode && (
          <span className="font-medium text-foreground">
            {sessionsBeingMoved === 1
              ? "Pick a time. "
              : `Pick ${sessionsBeingMoved} times. `}
          </span>
        )}
        {/* The allocate page has no separate heading, so the hint names the client. */}
        {policy.kind === "ALLOCATE" && subject.consulteeName
          ? `Choose the times for ${subject.consulteeName}'s booking. Green is free for both of you; anything else is already taken.`
          : movingShortNotice && policy.shortNoticeHint
            ? policy.shortNoticeHint
            : policy.pickerHint}
      </p>

      {/* The grid carries the zone line in its context row; the day list needs its own. */}
      {useDayList && (
        <>
          {gridContextChips.length > 0 && (
            <SchedulingContextBar
              className="shrink-0"
              chips={gridContextChips}
            />
          )}
          {zoneLine}
        </>
      )}

      {picker}

      {/* Only "select" needs a footer — the allocate grid renders its own. */}
      {isSelectMode && (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {/* "Any time, but ideally these": ranks candidates, never rules any out. */}
          {canStatePreference && picked.length === 0 && (
            <div className="mr-auto flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">Ideally</span>
              <Select value={timeOfDay} onValueChange={setTimeOfDay}>
                <SelectTrigger
                  className="h-9 w-[9.5rem]"
                  aria-label="Preferred time of day"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIME_OF_DAY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={days} onValueChange={setDays}>
                <SelectTrigger
                  className="h-9 w-[8rem]"
                  aria-label="Preferred days"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DAYS_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* The grid's session tray already counts its picks. */}
          {useDayList && picked.length > 0 && (
            <p className="mr-auto text-sm text-muted-foreground">
              {pickedTimes} of {sessionsBeingMoved}{" "}
              {sessionsBeingMoved === 1 ? "time" : "times"} picked.
            </p>
          )}

          {onCancel && (
            <Button
              variant="outline"
              onClick={onCancel}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
          )}

          {/* Naming a time is an option, never a requirement: releasing without
              one hands the counterparty a request to place. */}
          {offersAnyTime && (
            <Button
              variant="outline"
              onClick={() => submit(false)}
              disabled={isSubmitting || selectionIncomplete}
            >
              Any time works
            </Button>
          )}

          <Button
            onClick={() => submit(true)}
            disabled={
              isSubmitting ||
              blocked ||
              selectionIncomplete ||
              picked.length !== requiredProposedSlots
            }
            title={submitButtonTitle({
              isSubmitting,
              blocked,
              selectionIncomplete,
              pickedTimes,
              neededTimes: sessionsBeingMoved,
              allowReleaseWithoutTime: offersAnyTime,
            })}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Processing...
              </>
            ) : (
              policy.submitLabel
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
