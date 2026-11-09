"use client";

import { leadLabel } from "@/lib/booking/lead-time";
import type { GridLead } from "@/lib/scheduling/allocationService";
import { captureClientException } from "@/lib/observability/client-capture";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TWENTY_FOUR_HOURS_IN_MS } from "@/utils/scheduling-engine/slotTimeUtils";
import { isRecurringEventType } from "@/utils/scheduling-engine/types";
import {
  addDays,
  startOfWeek,
  endOfWeek,
  addWeeks,
  subWeeks,
  addMonths,
  subMonths,
  isSameMonth,
  getDay,
  getDaysInMonth,
  type Day,
} from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import {
  ChevronLeft,
  ChevronRight,
  Calendar,
  Users,
  Zap,
  RotateCcw,
  CalendarCheck,
  AlertTriangle,
} from "lucide-react";
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  CalendarInterval,
  calculateRequiredSlots,
  calculateCallProgress,
  countSundayWeeksInclusive,
  groupSelectedIntoSessions,
  splitIntoSessions,
} from "@/lib/scheduling/calendarUtils";
import { CalendarGridSkeleton } from "@/components/scheduling/CalendarSkeletons";
import { useCalendarData } from "@/hooks/scheduling/useCalendarData";
import {
  lastInstantBefore,
  subscriptionCycleHeading,
  subscriptionEntitlement,
  type SubscriptionEntitlement,
} from "@/lib/booking/entitlement";
import {
  earliestSelectedSlot,
  useEventSlotAllocation,
} from "@/hooks/scheduling/useScheduling";
import type { AllocationResponse } from "@/lib/scheduling/allocationService";
import { ScheduleCalculationService } from "@/utils/scheduling-engine/ScheduleCalculationService";
import {
  outsideSchedulingWindow,
  pastSlotBlocked,
  pastSessionBlocked,
  sessionTooSoon,
  sessionBeingRescheduled,
  slotUnavailable,
  notEnoughConsecutive,
} from "@/lib/scheduling/allocationMessages";
import { useToast } from "@/hooks/use-toast";
import type { SlotStatusKey } from "@/lib/scheduling/interval-status-tokens";
import { quotaFooterText } from "@/lib/scheduling/grid-quota";
import { MINIMUM_BOOKING_LEAD_TIME_MS } from "@/lib/payments/constants";
import {
  FOCUS_LEAD_ROWS,
  focusGridPosition,
  focusScrollRow,
  focusTargetMinute,
  gridTimeZone,
  rowIndexForMinute,
  type TimePickerFocus,
} from "@/lib/scheduling/time-picker-focus";
import { cn } from "@/utils/tailwind";
import { buildGridBlocks } from "@/lib/scheduling/grid-blocks";
import {
  buildWeekCells,
  describeAtom,
  expandToSession,
  openHoursWindow,
  selectionConflicts,
  type AtomContext,
  type CellView,
  type RowWindow,
} from "@/lib/scheduling/week-grid-model";
import {
  formatClockTime,
  formatDateLabel,
  formatDateRangeLabel,
  formatDayLabel,
  formatMonthLabel,
} from "@/lib/time/display";
import {
  ATOM_MS,
  atomOf,
  calendarDateKey,
  calendarDayOf,
  canSwitchToDeviceZone,
  footerZoneLine,
  isOnCalendarDay,
  resolveGridZone,
  weekRowModel,
} from "@/lib/time/grid-zone";
import { ZoneSwitch } from "@/components/scheduling/ZoneSwitch";
import {
  overlapTooltip,
  WeekGrid,
  type CellTooltip,
  type GhostPiece,
  type GridFocus,
} from "@/components/scheduling/WeekGrid";

function getSlotsPerCall(sessionDurationInHours?: number): number {
  return Math.ceil((sessionDurationInHours || 1) / 0.5);
}

/** Minutes as a phrase a person would use — never a count of half-hours. */
function formatDurationLabel(minutes: number): string {
  if (minutes % 60 !== 0) return `${minutes} min`;
  const hours = minutes / 60;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

function sessionsPhrase(count: number): string {
  return `${count} session${count === 1 ? "" : "s"}`;
}

function eventTypeLabel(eventType: UnifiedCalendarProps["eventType"]): string {
  switch (eventType) {
    case "consultation":
      return "Consultation";
    case "subscription":
      return "Subscription";
    case "webinar":
      return "Webinar";
    case "class":
      return "Class";
  }
}

/** The calendar days of the visible week that sit inside the booking's dates, read in `zone`. */
function inPeriodDays(
  days: readonly Date[],
  zone: string,
  allowedStart?: Date,
  allowedEnd?: Date,
): boolean[] {
  if (!allowedStart && !allowedEnd) return days.map(() => false);
  const startKey = allowedStart
    ? calendarDateKey(calendarDayOf(allowedStart, zone))
    : null;
  const endKey = allowedEnd
    ? calendarDateKey(calendarDayOf(lastInstantBefore(allowedEnd), zone))
    : null;
  return days.map((day) => {
    const key = calendarDateKey(day);
    return (!startKey || key >= startKey) && (!endKey || key <= endKey);
  });
}

/** Footer text for a subscription; the legacy progress line when no window. */
function subscriptionFooterText(
  params: Readonly<{
    selectedSlots: CalendarInterval[];
    allowedStart?: Date;
    allowedEnd?: Date;
    sessionsPerWeek?: number;
    sessionDurationInHours?: number;
    totalSessions?: number;
    pastEventSlotCount: number;
    maxSlots: number;
    schedulingTimezone?: string;
    entitlement: SubscriptionEntitlement | null;
    zone: string;
  }>,
): string {
  const slotsPerCall = getSlotsPerCall(params.sessionDurationInHours);
  if (params.entitlement) {
    return cycleFooterText(
      params.entitlement,
      Math.floor(params.selectedSlots.length / slotsPerCall),
      params.zone,
    );
  }
  const computed = computeSubscriptionFooter({
    selectedSlots: params.selectedSlots,
    allowedStart: params.allowedStart,
    allowedEnd: params.allowedEnd,
    sessionsPerWeek: params.sessionsPerWeek,
    sessionDurationInHours: params.sessionDurationInHours,
    totalSessions: params.totalSessions,
    pastCompletedSessions: Math.floor(params.pastEventSlotCount / slotsPerCall),
  });
  if (computed) return computed;
  return calculateCallProgress(
    params.selectedSlots,
    params.sessionDurationInHours,
    params.maxSlots,
    params.schedulingTimezone,
  );
}

/** Footer text for a class: sessions scheduled against the plan's total. */
function classFooterText(
  params: Readonly<{
    selectedSlots: CalendarInterval[];
    sessionDurationInHours?: number;
    totalSessions?: number;
    pastEventSlotCount: number;
    schedulingTimezone?: string;
  }>,
): string {
  const slotsPerSession = getSlotsPerCall(params.sessionDurationInHours);
  return computeClassFooter({
    selectedSlots: params.selectedSlots,
    sessionDurationInHours: params.sessionDurationInHours,
    totalSessions: params.totalSessions,
    pastCompletedSessions: Math.floor(
      params.pastEventSlotCount / slotsPerSession,
    ),
    schedulingTimezone: params.schedulingTimezone,
  });
}

/**
 * A subscription's week grid starts on the day its cycle starts, so the seven
 * columns are the cycle; everything else starts on Sunday.
 */
export function weekStartFor(subject: {
  eventType: UnifiedCalendarProps["eventType"];
  cycleStart?: Date | null;
  /** The zone the grid is drawn in; the cycle's start day is read there. */
  zone: string;
}): Day {
  return subject.eventType === "subscription" && subject.cycleStart
    ? (getDay(calendarDayOf(subject.cycleStart, subject.zone)) as Day)
    : 0;
}

/** What the window banner calls the range, per subject. */
function windowBannerLabel(
  eventType: UnifiedCalendarProps["eventType"],
): string {
  if (eventType === "subscription") return "This cycle";
  if (eventType === "consultation") return "Requested window";
  return "Scheduling period";
}

/** Formats the allowed [start, end] range in the grid's zone. */
function formatAllowedRange(
  zone: string,
  allowedStart?: Date,
  allowedEnd?: Date,
): string {
  const at = (date?: Date) =>
    date
      ? `${formatDateLabel(date, { zone })} at ${formatClockTime(date, { zone })}`
      : "-";
  // The end is exclusive: a midnight end means "through the day before".
  const until = (date?: Date) => {
    if (!date) return "-";
    const { hour, minute } = ScheduleCalculationService.wallClock(date, zone);
    return hour === 0 && minute === 0
      ? `end of ${formatDateLabel(lastInstantBefore(date), { zone })}`
      : at(date);
  };
  return `${at(allowedStart)} – ${until(allowedEnd)}`;
}

/**
 * The subscription footer reads the one entitlement counter: the cycle
 * heading while nothing is selected, then the selection against this cycle.
 */
function cycleFooterText(
  entitlement: SubscriptionEntitlement,
  selectedSessions: number,
  zone: string,
): string {
  if (selectedSessions === 0) {
    return subscriptionCycleHeading(entitlement, { zone });
  }
  const { nextBatch } = entitlement.cycle;
  const plan = `${entitlement.held + selectedSessions} of ${entitlement.total} scheduled`;
  if (selectedSessions >= nextBatch) {
    return `This cycle's ${sessionsPhrase(nextBatch)} picked · ${plan}`;
  }
  return `${selectedSessions} of ${nextBatch} picked for this cycle · ${plan}`;
}

function computeSubscriptionFooter(
  params: Readonly<{
    selectedSlots: CalendarInterval[];
    allowedStart?: Date;
    allowedEnd?: Date;
    sessionsPerWeek?: number;
    sessionDurationInHours?: number;
    totalSessions?: number;
    pastCompletedSessions?: number;
  }>,
): string | null {
  const {
    selectedSlots,
    allowedStart,
    allowedEnd,
    sessionsPerWeek,
    sessionDurationInHours,
    totalSessions,
    pastCompletedSessions = 0,
  } = params;

  let maxTotalCalls: number;
  if (totalSessions && totalSessions > 0) {
    maxTotalCalls = totalSessions;
  } else {
    if (!allowedStart || !allowedEnd || !sessionsPerWeek) return null;
    const weeks = countSundayWeeksInclusive(
      allowedStart,
      lastInstantBefore(allowedEnd),
    );
    maxTotalCalls = weeks * sessionsPerWeek;
  }
  const slotsPerCall = getSlotsPerCall(sessionDurationInHours);
  const scheduled = Math.floor(selectedSlots.length / slotsPerCall);
  const totalScheduled = scheduled + pastCompletedSessions;
  const remaining = maxTotalCalls - totalScheduled;
  const durationText = formatDurationLabel((sessionDurationInHours || 1) * 60);

  if (pastCompletedSessions > 0 && scheduled === 0) {
    return `${sessionsPhrase(pastCompletedSessions)} done · pick ${remaining} more (${durationText} each)`;
  }
  if (pastCompletedSessions > 0 && remaining > 0) {
    return `${totalScheduled} of ${maxTotalCalls} (${pastCompletedSessions} done + ${scheduled} new) · ${remaining} to go`;
  }
  if (scheduled === 0) {
    return `Choose times for ${sessionsPhrase(maxTotalCalls)} (${durationText} each)`;
  }
  if (remaining > 0) {
    return `${scheduled} of ${maxTotalCalls} sessions picked · ${remaining} to go`;
  }
  return `All ${sessionsPhrase(maxTotalCalls)} picked`;
}

/** Total completed class sessions across the selection. */
function countCompletedSelectedClasses(
  selectedSlots: CalendarInterval[],
  slotsPerSession: number,
  schedulingTimezone?: string,
): number {
  if (!selectedSlots?.length) return 0;
  const byDay = new Map<string, CalendarInterval[]>();
  for (const s of selectedSlots) {
    const key = ScheduleCalculationService.dayKey(
      s.startTime,
      schedulingTimezone,
    );
    const list = byDay.get(key) ?? [];
    list.push(s);
    byDay.set(key, list);
  }
  let sessions = 0;
  byDay.forEach((daySlots) => {
    const sorted = [...daySlots].sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime(),
    );
    let run = 0;
    let lastEnd: number | null = null;
    for (const slot of sorted) {
      if (lastEnd !== null && slot.startTime.getTime() !== lastEnd) {
        sessions += Math.floor(run / slotsPerSession);
        run = 0;
      }
      run += 1;
      lastEnd = slot.endTime.getTime();
    }
    sessions += Math.floor(run / slotsPerSession);
  });
  return sessions;
}

function computeClassFooter(params: {
  selectedSlots: CalendarInterval[];
  sessionDurationInHours?: number;
  totalSessions?: number;
  pastCompletedSessions?: number;
  schedulingTimezone?: string;
}): string {
  const {
    selectedSlots,
    sessionDurationInHours,
    totalSessions,
    pastCompletedSessions = 0,
    schedulingTimezone,
  } = params;
  const slotsPerSession = getSlotsPerCall(sessionDurationInHours);
  const scheduled = countCompletedSelectedClasses(
    selectedSlots,
    slotsPerSession,
    schedulingTimezone,
  );
  const totalScheduled = scheduled + pastCompletedSessions;
  const durationText = formatDurationLabel((sessionDurationInHours || 1) * 60);

  if (typeof totalSessions === "number" && totalSessions > 0) {
    const remaining = totalSessions - totalScheduled;
    if (pastCompletedSessions > 0 && scheduled === 0) {
      return `${sessionsPhrase(pastCompletedSessions)} done · pick ${remaining} more (${durationText} each)`;
    }
    if (remaining > 0) {
      return pastCompletedSessions > 0
        ? `${totalScheduled} of ${totalSessions} (${pastCompletedSessions} done + ${scheduled} new) · ${remaining} to go`
        : `${scheduled} picked · ${remaining} to go (${durationText} each)`;
    }
    return `All ${sessionsPhrase(totalSessions)} picked`;
  }
  return `Sessions picked: ${totalScheduled}`;
}

export interface UnifiedCalendarProps {
  consultantId: string;
  eventType: "consultation" | "subscription" | "webinar" | "class";
  eventId?: string;
  durationInMonths?: number;
  /** Consultations and webinars: the one session's length. */
  durationInHours?: number;
  sessionsPerWeek?: number;
  /** Subscriptions and classes: each session's length. */
  sessionDurationInHours?: number;
  /** The consultee whose other bookings read busy; allocation rejects those. */
  consulteeUserId?: string;
  mode: "view" | "select" | "allocate";
  onSlotsSelected?: (slots: CalendarInterval[]) => void;
  onAllocationComplete?: (result: AllocationResponse) => void;
  /** The request was allocated elsewhere or can no longer be allocated: close. */
  onAllocationConflict?: () => void;
  /** The request's tentative state moved under this tab: reload the subject in place. */
  onRequestRefresh?: () => void;
  /** Fresh PENDING allocations only: reject if confirmed sessions already exist. */
  initialAllocation?: boolean;
  /** Tentative count captured when the page opened (stale-tab guard). */
  expectedTentativeSlotCount?: number;
  onClose?: () => void;
  showAllocationButtons?: boolean;
  /** Rendered between the grid and the footer (the legend, on the allocate page). */
  aboveActionsSlot?: React.ReactNode;
  /** Occurrences a reschedule would release; the plan-limit overlay counts them free. */
  releasingOccurrenceIds?: readonly string[];
  /** The writer this grid is drawn for; its lead time decides "too soon". */
  lead?: GridLead;
  /** The client's requested times, outlined on the allocate grid. */
  requestedSlots?: { startsAt: Date | string; endsAt?: Date | string | null }[];
  className?: string;
  /** Selectable window; cells outside paint "Outside period". */
  allowedStart?: Date;
  allowedEnd?: Date;
  /** Authoritative session count from the plan. */
  totalSessions?: number;
  /** The event's scheduling zone: the limit day/week buckets. */
  schedulingTimezone?: string;
  /** Where to be looking on open; applied once. */
  focus?: TimePickerFocus;
  /** Legend choice for SafeUnifiedCalendar. */
  showConsultantLegend?: boolean;
  /** The viewer's profile zone; the grid is drawn in it unless they switch. */
  viewerZone?: string | null;
  /** False when the host renders the zone switch itself for the whole page. */
  showZoneSwitch?: boolean;
  /** The states painted in the visible week, for a legend that shows only them. */
  onPaintedKeysChange?: (
    keys: ReadonlySet<SlotStatusKey>,
    counts?: ReadonlyMap<SlotStatusKey, number>,
  ) => void;
  /** True while the booking's own sessions failed to load; the host blocks its submit. */
  onBlockingIssueChange?: (blocked: boolean) => void;
}

/**
 * A subscription's limit is THIS cycle: completed + nextBatch (or the
 * reschedule batch), so requiredSlots comes out as batch × slotsPerCall. In
 * select mode totalSessions is the exact number of sessions being moved.
 */
function resolveMaxTotalCalls(
  entitlement: SubscriptionEntitlement | null,
  eventType: UnifiedCalendarProps["eventType"],
  totalSessions: number | undefined,
  allowedStart: Date | undefined,
  allowedEnd: Date | undefined,
  sessionsPerWeek: number | undefined,
  mode?: UnifiedCalendarProps["mode"],
): number | undefined {
  if (mode === "select" && totalSessions && totalSessions > 0) {
    return totalSessions;
  }
  if (entitlement) {
    const batch =
      entitlement.rescheduling > 0
        ? entitlement.rescheduling
        : entitlement.cycle.nextBatch;
    return entitlement.completed + batch;
  }
  if (!isRecurringEventType(eventType)) return undefined;
  if (totalSessions && totalSessions > 0) return totalSessions;
  if (allowedStart && allowedEnd && sessionsPerWeek) {
    return (
      countSundayWeeksInclusive(allowedStart, lastInstantBefore(allowedEnd)) *
      (sessionsPerWeek || 1)
    );
  }
  return undefined;
}

function resolvePastConfirmedSlotCount(
  entitlement: SubscriptionEntitlement | null,
  eventType: UnifiedCalendarProps["eventType"],
  slotsPerCallForCycle: number,
  pastEventSlotCount: number,
  mode?: UnifiedCalendarProps["mode"],
): number | undefined {
  if (mode === "select") return 0;
  if (entitlement) return entitlement.completed * slotsPerCallForCycle;
  if (isRecurringEventType(eventType)) return pastEventSlotCount;
  return undefined;
}

const EMPTY_STARTS: ReadonlySet<number> = new Set();

function startsOf(slots: readonly { startTime: Date }[]): Set<number> {
  return new Set(slots.map((slot) => slot.startTime.getTime()));
}

function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

export function UnifiedCalendar({
  consultantId,
  eventType,
  durationInHours,
  sessionDurationInHours,
  eventId,
  durationInMonths,
  sessionsPerWeek,
  consulteeUserId,
  mode = "view",
  onSlotsSelected,
  onAllocationComplete,
  onAllocationConflict,
  onRequestRefresh,
  initialAllocation,
  expectedTentativeSlotCount,
  onClose,
  showAllocationButtons = false,
  aboveActionsSlot,
  releasingOccurrenceIds,
  lead,
  requestedSlots,
  className = "",
  allowedStart,
  allowedEnd,
  totalSessions,
  schedulingTimezone,
  focus,
  viewerZone,
  showZoneSwitch = true,
  onPaintedKeysChange,
  onBlockingIssueChange,
}: UnifiedCalendarProps) {
  const { toast } = useToast();
  // Client-only (SafeUnifiedCalendar loads it with ssr false), so the device
  // zone can be read once on mount.
  const [deviceZone] = useState(() => gridTimeZone());
  const [usingDeviceZone, setUsingDeviceZone] = useState(false);
  const canSwitchZone =
    showZoneSwitch && canSwitchToDeviceZone(viewerZone, deviceZone);
  const gridZone = resolveGridZone(
    viewerZone,
    deviceZone,
    canSwitchZone && usingDeviceZone,
  );

  const [currentDate, setCurrentDate] = useState(() => {
    if (!focus) return new Date();
    const { year, month, day } = focusGridPosition(focus.at, gridZone);
    return new Date(year, month - 1, day, 12);
  });
  const [view, setView] = useState<"week" | "month">("week");
  // The one wall clock for the grid: past, the now-line, Today.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(tick);
  }, []);
  const nowMs = now.getTime();
  // Cells only change at half-hour boundaries; the matrix follows the boundary,
  // not the minute, so a tick re-renders the now-line alone.
  const matrixNowMs = Math.floor(nowMs / ATOM_MS) * ATOM_MS + 1;

  const weekStartsOn = weekStartFor({
    eventType,
    cycleStart: allowedStart,
    zone: gridZone,
  });

  const {
    consultantDetails,
    serverCells,
    cellsWindow,
    availableSlots,
    eventSlots,
    eventTentativeSlots,
    eventOccurrences,
    subscriptionMeta,
    quota,
    leadMs,
    loading,
    refreshing,
    error,
    refreshFailed,
    eventSlotsFailed,
    availabilityFreshness: freshness,
    refetch,
    refetchEventSlots,
    refetchAvailability,
  } = useCalendarData({
    consultantId,
    eventType,
    eventId,
    currentDate,
    view,
    mode,
    allowedStart,
    allowedEnd,
    consulteeUserId,
    gridZone,
    weekStartsOn,
    releasingOccurrenceIds,
    lead,
    // Only the consultant's own allocate surface may ask for overlap detail.
    includeAppointmentDetails: mode === "allocate",
  });

  const effectiveSchedulingTz =
    schedulingTimezone ?? consultantDetails?.timezone ?? null;

  const onAllocationCompleteRef = useLatest(onAllocationComplete);
  const onAllocationConflictRef = useLatest(onAllocationConflict);
  const onRequestRefreshRef = useLatest(onRequestRefresh);

  const handleAllocationSuccess = useCallback(
    async (result: AllocationResponse) => {
      try {
        // Own sessions first: availability then reads them as this booking's.
        await refetchEventSlots();
        await refetchAvailability();
      } catch (refetchError) {
        captureClientException(
          refetchError instanceof Error
            ? refetchError
            : new Error(String(refetchError)),
          { tags: { subsystem: "client" } },
        );
      }
      onAllocationCompleteRef.current?.(result);
    },
    [refetchEventSlots, refetchAvailability, onAllocationCompleteRef],
  );

  const pastEventSlotCount = useMemo(
    () => eventSlots.filter((s) => s.endTime.getTime() <= matrixNowMs).length,
    [eventSlots, matrixNowMs],
  );

  // The one counter: what this cycle still takes and what the plan holds.
  const entitlement = useMemo(
    () =>
      eventType === "subscription" && subscriptionMeta
        ? subscriptionEntitlement({
            ...subscriptionMeta,
            occurrences: eventOccurrences,
            now: new Date(matrixNowMs),
          })
        : null,
    [eventType, subscriptionMeta, eventOccurrences, matrixNowMs],
  );
  const slotsPerCallForCycle = getSlotsPerCall(sessionDurationInHours);
  const hasReschedule =
    eventTentativeSlots.length > 0 ||
    (entitlement ? entitlement.rescheduling > 0 : false);

  // A refusal proves the cells stale: refetch both, best-effort, never
  // masking the toast that explained the refusal.
  const refreshGridData = useCallback(() => {
    void Promise.all([refetchAvailability(), refetchEventSlots()]).catch(
      (refetchError) => {
        captureClientException(
          refetchError instanceof Error
            ? refetchError
            : new Error(String(refetchError)),
          { tags: { subsystem: "client" } },
        );
      },
    );
  }, [refetchAvailability, refetchEventSlots]);

  const handleConflict = useCallback(() => {
    const close = onAllocationConflictRef.current;
    if (close) close();
    else refreshGridData();
  }, [onAllocationConflictRef, refreshGridData]);

  const handleRequestChanged = useCallback(() => {
    refreshGridData();
    onRequestRefreshRef.current?.();
  }, [refreshGridData, onRequestRefreshRef]);

  const maxTotalCalls = resolveMaxTotalCalls(
    entitlement,
    eventType,
    totalSessions,
    allowedStart,
    allowedEnd,
    sessionsPerWeek,
    mode,
  );
  const pastConfirmedSlotCount = resolvePastConfirmedSlotCount(
    entitlement,
    eventType,
    slotsPerCallForCycle,
    pastEventSlotCount,
    mode,
  );
  const topUp =
    mode === "allocate" && entitlement
      ? !hasReschedule && entitlement.held > 0
      : undefined;

  // Stable options, so the selection hook's memos and callbacks hold between renders.
  const allocationOptions = useMemo(
    () => ({
      eventType,
      eventId: eventId || "",
      consultantId,
      durationInMonths,
      durationInHours,
      sessionsPerWeek,
      sessionDurationInHours,
      startDate: allowedStart,
      endDate: allowedEnd,
      maxTotalCalls,
      pastConfirmedSlotCount,
      topUp,
      initialAllocation,
      expectedTentativeSlotCount,
      schedulingTimezone: effectiveSchedulingTz ?? undefined,
      displayZone: gridZone,
      onSuccess: handleAllocationSuccess,
      onConflict: handleConflict,
      onRequestChanged: handleRequestChanged,
      onStaleData: refreshGridData,
    }),
    [
      eventType,
      eventId,
      consultantId,
      durationInMonths,
      durationInHours,
      sessionsPerWeek,
      sessionDurationInHours,
      allowedStart,
      allowedEnd,
      maxTotalCalls,
      pastConfirmedSlotCount,
      topUp,
      initialAllocation,
      expectedTentativeSlotCount,
      effectiveSchedulingTz,
      gridZone,
      handleAllocationSuccess,
      handleConflict,
      handleRequestChanged,
      refreshGridData,
    ],
  );

  const {
    selectedSlots,
    isAllocating,
    isValid,
    validationErrors,
    requiredSlots,
    toggleSlot,
    clearSlots,
    removeSlots,
    manualAllocate,
    autoAllocate,
    partialOffer,
    dismissPartialOffer,
    slotLimits,
  } = useEventSlotAllocation(allocationOptions);

  // The dialog animates out after `partialOffer` clears; keep the last one
  // for its text without writing a ref during render.
  const [shownOffer, setShownOffer] = useState(partialOffer);
  useEffect(() => {
    if (partialOffer) setShownOffer(partialOffer);
  }, [partialOffer]);
  const offer = partialOffer ?? shownOffer;

  const eventStarts = useMemo(() => startsOf(eventSlots), [eventSlots]);
  const tentativeStarts = useMemo(
    () => startsOf(eventTentativeSlots),
    [eventTentativeSlots],
  );
  const selectedStarts = useMemo(
    () => startsOf(selectedSlots),
    [selectedSlots],
  );
  const requestedStarts = useMemo(() => {
    if (!requestedSlots?.length) return EMPTY_STARTS;
    const starts = new Set<number>();
    for (const slot of requestedSlots) {
      const startMs = new Date(slot.startsAt).getTime();
      const endMs = slot.endsAt
        ? new Date(slot.endsAt).getTime()
        : startMs + ATOM_MS;
      if (!Number.isFinite(startMs) || !(endMs > startMs)) continue;
      for (
        let atom = Math.floor(startMs / ATOM_MS) * ATOM_MS;
        atom < endMs;
        atom += ATOM_MS
      ) {
        starts.add(atom);
      }
    }
    return starts;
  }, [requestedSlots]);

  const allowedStartMs = allowedStart?.getTime();
  const allowedEndMs = allowedEnd?.getTime();
  const baseContext = useMemo<AtomContext>(
    () => ({
      serverCells,
      eventStarts,
      tentativeStarts,
      selectedStarts,
      justTakenStarts: EMPTY_STARTS,
      requestedStarts,
      nowMs: matrixNowMs,
      allowedStartMs,
      allowedEndMs,
      leadMs,
    }),
    [
      serverCells,
      eventStarts,
      tentativeStarts,
      selectedStarts,
      requestedStarts,
      matrixNowMs,
      allowedStartMs,
      allowedEndMs,
      leadMs,
    ],
  );

  // A selection the latest data no longer allows paints "Just taken" for the
  // render that reveals it; the effect below then drops it and says so.
  // Not judged while a save is in flight or this booking's own sessions are
  // unknown: either would read our own times as someone else's.
  const conflicts = useMemo(
    () =>
      mode === "view" || isAllocating || eventSlotsFailed
        ? new Map<number, "taken" | "expired">()
        : selectionConflicts(selectedStarts, baseContext, cellsWindow),
    [
      mode,
      isAllocating,
      eventSlotsFailed,
      selectedStarts,
      baseContext,
      cellsWindow,
    ],
  );
  const atomContext = useMemo<AtomContext>(() => {
    if (conflicts.size === 0) return baseContext;
    const justTaken = new Set<number>();
    conflicts.forEach((reason, startMs) => {
      if (reason === "taken") justTaken.add(startMs);
    });
    return { ...baseContext, justTakenStarts: justTaken };
  }, [baseContext, conflicts]);

  useEffect(() => {
    if (conflicts.size === 0) return;
    const zone = effectiveSchedulingTz ?? gridZone;
    const doomed = groupSelectedIntoSessions(selectedSlots, zone).flatMap(
      (session) => {
        const atoms = selectedSlots.filter(
          (slot) =>
            slot.startTime >= session.start && slot.endTime <= session.end,
        );
        return atoms.some((slot) => conflicts.has(slot.startTime.getTime()))
          ? atoms
          : [];
      },
    );
    removeSlots(
      doomed.length > 0
        ? doomed
        : selectedSlots.filter((slot) =>
            conflicts.has(slot.startTime.getTime()),
          ),
    );
    const anyTaken = [...conflicts.values()].includes("taken");
    toast({
      variant: "destructive",
      title: anyTaken
        ? "One of your chosen times was just taken"
        : "One of your chosen times can't be booked any more",
      description: anyTaken
        ? "That time is no longer free, so it has been removed — pick another time."
        : "It is now too close to its start or past this plan's limit. It has been removed — pick another time.",
    });
  }, [
    conflicts,
    selectedSlots,
    removeSlots,
    toast,
    effectiveSchedulingTz,
    gridZone,
  ]);

  // Report the selection when it changes, not when the parent re-renders.
  const onSlotsSelectedRef = useLatest(onSlotsSelected);
  useEffect(() => {
    if (mode === "select") {
      onSlotsSelectedRef.current?.(selectedSlots);
    }
  }, [selectedSlots, mode, onSlotsSelectedRef]);

  const onBlockingIssueChangeRef = useLatest(onBlockingIssueChange);
  useEffect(() => {
    onBlockingIssueChangeRef.current?.(eventSlotsFailed);
  }, [eventSlotsFailed, onBlockingIssueChangeRef]);

  const configWarning = useMemo(() => {
    if (eventType === "consultation" || eventType === "webinar") {
      return !durationInHours || durationInHours <= 0
        ? `${eventTypeLabel(eventType)} length isn't set, so 1 hour is assumed.`
        : null;
    }
    return !sessionDurationInHours || sessionDurationInHours <= 0
      ? `${eventType === "subscription" ? "Session" : "Class"} length isn't set, so 1 hour is assumed.`
      : null;
  }, [eventType, durationInHours, sessionDurationInHours]);

  // The visible week as local-noon calendar dates; the fetch window uses the same start.
  const weekDates = useMemo(() => {
    const start = startOfWeek(currentDate, { weekStartsOn });
    return Array.from({ length: 7 }, (_, i) => {
      const day = addDays(start, i);
      return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12);
    });
  }, [currentDate, weekStartsOn]);

  const rowModel = useMemo(
    () => weekRowModel(weekDates, gridZone),
    [weekDates, gridZone],
  );
  const weekCells = useMemo(
    () => buildWeekCells(rowModel, atomContext),
    [rowModel, atomContext],
  );
  const blocks = useMemo(
    () => buildGridBlocks(weekCells.matrix, gridZone),
    [weekCells.matrix, gridZone],
  );

  // "Open hours" crops to the week's live rows; an all-dead week has no window.
  const [hourRange, setHourRange] = useState<"open" | "full">("open");
  const openWindow = useMemo(
    () => openHoursWindow(weekCells.live),
    [weekCells.live],
  );
  const allDead = openWindow === null;
  const axisLength = rowModel.axis.length;
  const openFrom = openWindow?.from;
  const openTo = openWindow?.to;
  const rowWindow = useMemo<RowWindow>(
    () =>
      hourRange === "open" && openFrom !== undefined && openTo !== undefined
        ? { from: openFrom, to: openTo }
        : { from: 0, to: axisLength },
    [hourRange, openFrom, openTo, axisLength],
  );

  const onPaintedKeysChangeRef = useLatest(onPaintedKeysChange);
  useEffect(() => {
    onPaintedKeysChangeRef.current?.(
      weekCells.paintedKeys,
      weekCells.paintedCounts,
    );
  }, [weekCells, onPaintedKeysChangeRef]);

  const todayIndex = weekDates.findIndex((date) =>
    isOnCalendarDay(date, now, gridZone),
  );
  const nowAtom = atomOf(now);
  const periodDays = useMemo(
    () => inPeriodDays(weekDates, gridZone, allowedStart, allowedEnd),
    [weekDates, gridZone, allowedStart, allowedEnd],
  );
  const footerZone = footerZoneLine(now, gridZone, effectiveSchedulingTz);

  const [weekGridEl, setWeekGridEl] = useState<HTMLDivElement | null>(null);
  const focusAppliedRef = useRef(false);
  const [gridFocus, setGridFocus] = useState<GridFocus>({
    rowKey: "",
    dayIndex: 0,
  });

  // "Go to selection": switch week if needed, then scroll once it renders.
  const pendingSelectionScrollRef = useRef<string | null>(null);
  const scrollToSelection = useCallback(() => {
    const first = earliestSelectedSlot(selectedSlots);
    if (!first) return;
    pendingSelectionScrollRef.current = first.startTime.toISOString();
    setView("week");
    if (
      !weekDates.some((date) =>
        isOnCalendarDay(date, first.startTime, gridZone),
      )
    ) {
      setCurrentDate(calendarDayOf(first.startTime, gridZone));
    }
  }, [selectedSlots, weekDates, gridZone]);
  useEffect(() => {
    const target = pendingSelectionScrollRef.current;
    if (!target || !weekGridEl) return;
    const cell = weekGridEl.querySelector(`[data-slot-start="${target}"]`);
    const row = cell?.closest("[data-row]");
    if (!(row instanceof HTMLElement)) return;
    pendingSelectionScrollRef.current = null;
    weekGridEl.scrollTop +=
      row.getBoundingClientRect().top -
      weekGridEl.getBoundingClientRect().top -
      row.getBoundingClientRect().height * FOCUS_LEAD_ROWS;
  }, [weekGridEl, weekDates, rowWindow, selectedSlots]);

  // Where to look on open, once; a user who already scrolled keeps their place.
  useEffect(() => {
    if (!focus || focusAppliedRef.current || !weekGridEl) return;
    if (!weekGridEl.querySelector("[data-row]")) return;
    if (weekGridEl.scrollTop > 0) {
      focusAppliedRef.current = true;
      return;
    }
    const targetRow = rowIndexForMinute(
      rowModel.axis,
      focusTargetMinute(focus, availableSlots, gridZone),
    );
    const scrollRow = Math.min(
      Math.max(focusScrollRow(targetRow), rowWindow.from),
      rowWindow.to - 1,
    );
    const row = weekGridEl.querySelector(`[data-row="${scrollRow}"]`);
    if (!(row instanceof HTMLElement)) return;
    focusAppliedRef.current = true;
    weekGridEl.scrollTop +=
      row.getBoundingClientRect().top - weekGridEl.getBoundingClientRect().top;
  }, [focus, weekGridEl, availableSlots, rowWindow, gridZone, rowModel]);

  /** A free, placeable atom a session may grow into: what a click may take. */
  const isFreeAtom = useCallback(
    (startMs: number): boolean => {
      if (!serverCells.has(startMs) || selectedStarts.has(startMs)) {
        return false;
      }
      const atom = describeAtom(startMs, startMs + ATOM_MS, atomContext);
      return (
        atom.isAvailable &&
        !atom.isInPast &&
        !atom.isOutsidePeriod &&
        !atom.isTooSoon &&
        !atom.isLimitReached
      );
    },
    [serverCells, atomContext, selectedStarts],
  );

  /** Consecutive free atoms around a clicked one, to fill one whole session. */
  const buildAutoExpandGroup = useCallback(
    (clickedSlot: CalendarInterval): CalendarInterval[] => {
      const clickedMs = clickedSlot.startTime.getTime();
      return expandToSession(
        clickedMs,
        slotLimits.slotsPerSession,
        (startMs) => startMs === clickedMs || isFreeAtom(startMs),
      ).map((startMs) =>
        startMs === clickedMs
          ? clickedSlot
          : {
              startTime: new Date(startMs),
              endTime: new Date(startMs + ATOM_MS),
              isAvailable: true,
              isBooked: false,
            },
      );
    },
    [slotLimits.slotsPerSession, isFreeAtom],
  );

  /** The picked session holding an atom, as its atoms: a click removes all of them. */
  const sessionAtomsAt = useCallback(
    (startMs: number): CalendarInterval[] => {
      const session = splitIntoSessions(
        selectedSlots,
        slotLimits.slotsPerSession,
        gridZone,
      ).find(
        (piece) =>
          piece.start.getTime() <= startMs && startMs < piece.end.getTime(),
      );
      if (!session) return [];
      return selectedSlots.filter(
        (slot) =>
          slot.startTime >= session.start && slot.endTime <= session.end,
      );
    },
    [selectedSlots, slotLimits.slotsPerSession, gridZone],
  );

  // What a click on the hovered or focused cell would place, drawn as a ghost.
  const [previewStart, setPreviewStart] = useState<number | null>(null);
  const ghost = useMemo<GhostPiece[]>(() => {
    if (mode === "view" || isAllocating || previewStart === null) return [];
    if (weekCells.byStart.get(previewStart)?.statusKey !== "available") {
      return [];
    }
    const size = Math.max(1, slotLimits.slotsPerSession || 1);
    const starts = expandToSession(
      previewStart,
      size,
      (startMs) => startMs === previewStart || isFreeAtom(startMs),
    );
    const clicked = weekCells.positions.get(previewStart);
    if (!clicked) return [];
    if (starts.length < size) {
      return [
        {
          key: `blocked:${previewStart}`,
          dayIndex: clicked.day,
          fromRow: clicked.row,
          toRow: Math.min(clicked.row + size, weekCells.matrix.length),
          fits: false,
          startMs: previewStart,
          endMs: previewStart + size * ATOM_MS,
          label: "Doesn't fit here",
        },
      ];
    }
    // A session crossing midnight draws one piece per day column.
    const pieces: GhostPiece[] = [];
    for (const startMs of starts) {
      const position = weekCells.positions.get(startMs);
      if (!position) continue;
      const last = pieces[pieces.length - 1];
      if (last && last.dayIndex === position.day) {
        last.toRow = position.row + 1;
        last.endMs = startMs + ATOM_MS;
        continue;
      }
      pieces.push({
        key: `fits:${startMs}`,
        dayIndex: position.day,
        fromRow: position.row,
        toRow: position.row + 1,
        fits: true,
        startMs,
        endMs: startMs + ATOM_MS,
        label: "",
      });
    }
    return pieces.map((piece) => ({
      ...piece,
      label: `New session · ${formatClockTime(new Date(starts[0]), { zone: gridZone })}–${formatClockTime(new Date(starts[starts.length - 1] + ATOM_MS), { zone: gridZone })}`,
    }));
  }, [
    mode,
    isAllocating,
    previewStart,
    weekCells,
    slotLimits.slotsPerSession,
    isFreeAtom,
    gridZone,
  ]);

  const handleCellActivate = useCallback(
    (startMs: number) => {
      // The live cell, never one a memoised button closed over.
      const cell = weekCells.byStart.get(startMs);
      if (mode === "view" || !cell) return;
      const slot: CalendarInterval = {
        startTime: new Date(cell.startMs),
        endTime: new Date(cell.endMs),
        isAvailable: cell.isAvailable,
        isBooked: cell.isBooked,
      };
      const isSelected = selectedStarts.has(cell.startMs);

      // Already being dropped by the conflict effect.
      if (cell.statusKey === "justTaken") return;

      if (cell.isOutsidePeriod) {
        toast(
          outsideSchedulingWindow(
            formatAllowedRange(gridZone, allowedStart, allowedEnd),
          ),
        );
        return;
      }

      // Past sessions of this booking: deselect allowed, reselect blocked.
      if (cell.isThisEvent && cell.isInPast) {
        if (isSelected) removeSlots(sessionAtomsAt(cell.startMs));
        else toast(pastSessionBlocked());
        return;
      }
      // A session of this booking under 24 hours away cannot be moved.
      if (
        cell.isThisEvent &&
        cell.startMs < Date.now() + TWENTY_FOUR_HOURS_IN_MS
      ) {
        toast(sessionTooSoon());
        return;
      }
      if (cell.isInPast) {
        toast(pastSlotBlocked());
        return;
      }
      if (cell.isTentative) {
        toast(sessionBeingRescheduled());
        return;
      }
      if (!cell.isThisEvent && cell.statusKey === "tooSoon") {
        toast({
          title: "Too soon",
          description: `That time starts in less than ${leadLabel(leadMs ?? MINIMUM_BOOKING_LEAD_TIME_MS)} — pick a later one.`,
        });
        return;
      }
      if (!cell.isThisEvent && cell.statusKey === "limitReached") {
        toast({
          title: "Limit reached",
          description: quota
            ? `${quotaFooterText(quota, gridZone)}. Pick a day or week that still has room.`
            : "This plan's sessions for that week or day are already used.",
        });
        return;
      }
      if (cell.statusKey === "partiallyBooked") {
        toast({
          title: "Partly booked",
          description: "Part of this half-hour is taken — choose another time.",
        });
        return;
      }
      if (!cell.isThisEvent && (!cell.isAvailable || cell.isBooked)) {
        toast(slotUnavailable(cell.statusKey === "fullyBooked"));
        return;
      }

      if (isSelected) {
        removeSlots(sessionAtomsAt(cell.startMs));
        return;
      }
      const group = buildAutoExpandGroup(slot);
      const needed = slotLimits.slotsPerSession;
      if (needed > 1 && group.length < needed) {
        toast(notEnoughConsecutive(needed, group.length));
        return;
      }
      toggleSlot(slot, group);
    },
    [
      mode,
      selectedStarts,
      toast,
      leadMs,
      gridZone,
      allowedStart,
      allowedEnd,
      toggleSlot,
      removeSlots,
      sessionAtomsAt,
      quota,
      buildAutoExpandGroup,
      slotLimits.slotsPerSession,
      weekCells,
    ],
  );

  const tooltipOf = useCallback(
    (cell: CellView): CellTooltip | null => {
      if (cell.isThisEvent) {
        return {
          title: "This booking",
          lines: [
            eventTypeLabel(eventType),
            cell.isInPast ? "Past session" : "Click to change this time",
          ],
        };
      }
      if (
        cell.statusKey === "fullyBooked" ||
        cell.statusKey === "partiallyBooked"
      ) {
        return overlapTooltip(cell.overlapping);
      }
      return null;
    },
    [eventType],
  );

  const pageWeek = useCallback((direction: -1 | 1) => {
    setCurrentDate((previous) =>
      direction < 0 ? subWeeks(previous, 1) : addWeeks(previous, 1),
    );
  }, []);

  // Free, bookable half-hours per calendar day of the visible month.
  const monthFreeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (view !== "month") return counts;
    serverCells.forEach((cell) => {
      if (
        cell.bookingStatus !== "available" ||
        cell.tooSoon ||
        cell.limitReached ||
        cell.endMs < matrixNowMs
      ) {
        return;
      }
      const key = formatInTimeZone(cell.startMs, gridZone, "yyyy-MM-dd");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    return counts;
  }, [view, serverCells, gridZone, matrixNowMs]);

  const renderMonthView = () => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDayOfMonth = new Date(year, month, 1).getDay();
    const todayKey = calendarDateKey(calendarDayOf(now, gridZone));
    const weekdayHeaders = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return (
      <div className="grid min-h-0 flex-1 grid-cols-7 gap-1 overflow-y-auto">
        {weekdayHeaders.map((day) => (
          <div key={day} className="p-2 text-center font-bold">
            {day}
          </div>
        ))}
        {Array.from({ length: firstDayOfMonth }, (_, i) => (
          <div
            key={`empty-start-${i}`}
            className="min-h-[100px] border bg-gray-50/50"
          />
        ))}
        {Array.from({ length: getDaysInMonth(currentDate) }, (_, i) => {
          const date = new Date(year, month, i + 1, 12);
          const key = calendarDateKey(date);
          const isCurrentDay = key === todayKey;
          const isPastDay = key < todayKey;
          const freeCount = isPastDay ? 0 : (monthFreeCounts.get(key) ?? 0);
          return (
            <div
              key={key}
              className={cn(
                "flex min-h-[100px] flex-col border p-1",
                isCurrentDay && "ring-2 ring-primary",
                isPastDay ? "bg-gray-100 text-gray-500" : "bg-white",
              )}
            >
              <div
                className={cn(
                  "mb-1 text-xs font-bold",
                  isCurrentDay && "text-primary",
                  !isPastDay && "text-gray-700",
                )}
              >
                {i + 1}
              </div>
              <div className="flex flex-grow items-center justify-center">
                {!isPastDay && freeCount > 0 && (
                  <Badge variant="outline" className="p-1 text-[10px]">
                    {formatDurationLabel(freeCount * 30)} free
                  </Badge>
                )}
                {!isPastDay && freeCount === 0 && (
                  <span className="text-xs text-muted-foreground">
                    Nothing free
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  if (loading) {
    return <CalendarGridSkeleton className={className} />;
  }

  if (error) {
    return (
      <div
        role="alert"
        className={cn("rounded-md bg-red-50 p-4 text-red-800", className)}
      >
        <p>{error}</p>
        <Button variant="outline" size="sm" onClick={refetch} className="mt-2">
          <RotateCcw className="mr-2 h-4 w-4" />
          Try again
        </Button>
      </div>
    );
  }

  if (!consultantDetails) {
    return (
      <div className={cn("p-8 text-center text-muted-foreground", className)}>
        <Calendar className="mx-auto mb-4 h-12 w-12 opacity-50" />
        <p>This calendar isn&apos;t available right now.</p>
      </div>
    );
  }

  const slotsPerSession = Math.max(1, slotLimits.slotsPerSession || 1);
  const pickedSessions = Math.floor(selectedSlots.length / slotsPerSession);
  const neededSessions = Math.max(
    1,
    Math.round(requiredSlots / slotsPerSession),
  );
  const manualBlockedReason = (() => {
    if (isAllocating)
      return "Saving times — wait for the current attempt to finish.";
    if (eventSlotsFailed)
      return "This booking's own sessions didn't load. Try again before saving.";
    if (selectedSlots.length === 0) return "Pick the times first.";
    if (!isValid)
      return `This selection can't be saved: ${validationErrors.join(", ")}`;
    if (selectedSlots.length !== requiredSlots) {
      const missing = neededSessions - pickedSessions;
      return missing > 0
        ? `Pick ${sessionsPhrase(missing)} more.`
        : `Remove ${sessionsPhrase(-missing)} — ${sessionsPhrase(neededSessions)} needed.`;
    }
    return null;
  })();

  const footerText = (() => {
    try {
      if (eventType === "subscription") {
        return subscriptionFooterText({
          selectedSlots,
          allowedStart,
          allowedEnd,
          sessionsPerWeek,
          sessionDurationInHours,
          totalSessions,
          pastEventSlotCount,
          maxSlots: slotLimits.totalSessions,
          schedulingTimezone: effectiveSchedulingTz ?? undefined,
          entitlement,
          zone: gridZone,
        });
      }
      if (eventType === "class") {
        return classFooterText({
          selectedSlots,
          sessionDurationInHours,
          totalSessions: slotLimits.totalSessions,
          pastEventSlotCount,
          schedulingTimezone: effectiveSchedulingTz ?? undefined,
        });
      }
      const duration =
        eventType === "consultation" || eventType === "webinar"
          ? durationInHours
          : sessionDurationInHours;
      const totalMinutes =
        calculateRequiredSlots(
          eventType,
          durationInMonths,
          sessionsPerWeek,
          duration,
        ) * 30;
      const chosenMinutes = selectedSlots.length * 30;
      if (chosenMinutes === 0)
        return `Pick a ${formatDurationLabel(totalMinutes)} time`;
      if (chosenMinutes >= totalMinutes)
        return `${formatDurationLabel(totalMinutes)} picked`;
      return `${formatDurationLabel(chosenMinutes)} of ${formatDurationLabel(totalMinutes)} picked · pick ${formatDurationLabel(totalMinutes - chosenMinutes)} more`;
    } catch (footerError) {
      captureClientException(
        footerError instanceof Error
          ? footerError
          : new Error(String(footerError)),
        { tags: { subsystem: "client" } },
      );
      return `${pickedSessions} of ${neededSessions} times picked`;
    }
  })();

  return (
    <div className={cn("flex min-h-0 flex-col gap-4", className)}>
      {configWarning && (
        <div className="shrink-0 rounded-md border border-yellow-200 bg-yellow-50 px-4 py-3">
          <p className="text-sm text-yellow-800">{configWarning}</p>
        </div>
      )}

      {allowedStart && allowedEnd && (
        <div className="shrink-0 rounded-md border border-blue-200 bg-blue-50 px-4 py-3">
          <div className="flex items-start">
            <Calendar
              className="mr-2 h-5 w-5 flex-shrink-0 text-blue-600"
              aria-hidden
            />
            <div className="flex-1">
              <p className="text-sm font-medium text-blue-800">
                {windowBannerLabel(eventType)}
              </p>
              <p className="text-sm text-blue-700">
                {formatAllowedRange(gridZone, allowedStart, allowedEnd)}
              </p>
            </div>
          </div>
        </div>
      )}

      {refreshFailed && (
        <div
          role="alert"
          className="flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          <span className="flex-1">
            We couldn&apos;t refresh this calendar. The times below are the last
            ones that loaded.
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refetchAvailability()}
          >
            Try again
          </Button>
        </div>
      )}

      {eventSlotsFailed && (
        <div
          role="alert"
          className="flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          <span className="flex-1">
            This booking&apos;s own sessions didn&apos;t load, so they may show
            as booked and limits can&apos;t be checked yet.
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refetchEventSlots()}
          >
            Try again
          </Button>
        </div>
      )}

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 sm:gap-4">
        <div className="flex gap-2">
          <Button
            variant={view === "week" ? "default" : "outline"}
            size="sm"
            onClick={() => setView("week")}
            aria-pressed={view === "week"}
          >
            Week
          </Button>
          <Button
            variant={view === "month" ? "default" : "outline"}
            size="sm"
            onClick={() => setView("month")}
            aria-pressed={view === "month"}
          >
            Month
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            aria-label={view === "week" ? "Previous week" : "Previous month"}
            onClick={() =>
              setCurrentDate(
                view === "week"
                  ? subWeeks(currentDate, 1)
                  : subMonths(currentDate, 1),
              )
            }
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0 text-center text-sm font-bold sm:min-w-[150px] sm:text-lg">
            {view === "week"
              ? formatDateRangeLabel(
                  startOfWeek(currentDate, { weekStartsOn }),
                  endOfWeek(currentDate, { weekStartsOn }),
                )
              : formatMonthLabel(currentDate)}
          </div>
          <Button
            variant="outline"
            size="sm"
            aria-label={view === "week" ? "Next week" : "Next month"}
            onClick={() =>
              setCurrentDate(
                view === "week"
                  ? addWeeks(currentDate, 1)
                  : addMonths(currentDate, 1),
              )
            }
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCurrentDate(calendarDayOf(now, gridZone))}
            disabled={
              view === "week"
                ? todayIndex >= 0
                : isSameMonth(currentDate, calendarDayOf(now, gridZone))
            }
            title="Jump to today"
          >
            <CalendarCheck className="h-4 w-4 sm:mr-1" />
            <span className="hidden sm:inline">Today</span>
          </Button>
        </div>

        {view === "week" && (
          <div
            role="group"
            aria-label="Hours shown"
            className="inline-flex overflow-hidden rounded-md border border-input"
          >
            <button
              type="button"
              aria-pressed={hourRange === "open" && !allDead}
              disabled={allDead}
              onClick={() => setHourRange("open")}
              title={
                allDead
                  ? "Nothing is open this week, so every hour is shown."
                  : "Show the hours this week has open, with an hour either side."
              }
              className={cn(
                "px-3 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50",
                hourRange === "open" && !allDead
                  ? "bg-primary text-primary-foreground"
                  : "bg-background hover:bg-muted",
              )}
            >
              Open hours
            </button>
            <button
              type="button"
              aria-pressed={hourRange === "full" || allDead}
              onClick={() => setHourRange("full")}
              title="Show all 24 hours."
              className={cn(
                "border-l border-input px-3 py-1 text-xs font-medium",
                hourRange === "full" || allDead
                  ? "bg-primary text-primary-foreground"
                  : "bg-background hover:bg-muted",
              )}
            >
              Full day
            </button>
          </div>
        )}

        {mode === "allocate" ? (
          <Button
            variant="outline"
            size="sm"
            onClick={clearSlots}
            disabled={isAllocating || selectedSlots.length === 0}
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            Clear selection
          </Button>
        ) : (
          <div className="hidden w-20 sm:block" />
        )}
      </div>

      {showZoneSwitch && (
        <ZoneSwitch
          className="shrink-0"
          zone={gridZone}
          usingDeviceZone={canSwitchZone && usingDeviceZone}
          canSwitch={canSwitchZone}
          onToggle={() => setUsingDeviceZone((value) => !value)}
          now={now}
        />
      )}

      {view === "week" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {allDead && (
            <p
              role="status"
              className="mb-1 shrink-0 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground"
            >
              {weekCells.outsidePeriod.some(Boolean)
                ? "Nothing this week falls inside this booking's dates. Every hour is shown so you can see where the days are."
                : "Nothing is published this week. Every hour is shown so you can see where the days are."}
            </p>
          )}
          <WeekGrid
            days={weekDates}
            axis={rowModel.axis}
            matrix={weekCells.matrix}
            rows={rowWindow}
            blocks={blocks}
            ghost={ghost}
            onPreview={setPreviewStart}
            todayIndex={todayIndex}
            inPeriodDays={periodDays}
            nowAtomStartMs={nowAtom.start.getTime()}
            nowFraction={nowAtom.fraction}
            focus={gridFocus}
            zone={gridZone}
            readOnly={mode === "view"}
            refreshing={refreshing}
            tooltipOf={tooltipOf}
            onActivate={handleCellActivate}
            onFocusChange={setGridFocus}
            onPageWeek={pageWeek}
            gridRef={setWeekGridEl}
            label="Available half-hour times"
          />
        </div>
      ) : (
        renderMonthView()
      )}

      {mode !== "view" && (
        <div role="status" aria-live="polite" className="sr-only">
          {`${pickedSessions} of ${neededSessions} ${neededSessions === 1 ? "time" : "times"} picked`}
        </div>
      )}

      {aboveActionsSlot}
      <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="flex flex-wrap items-center gap-2 sm:gap-4">
          <div className="text-sm">
            {selectedSlots.length === 0 ? (
              footerText
            ) : (
              <button
                type="button"
                onClick={scrollToSelection}
                className="text-left underline decoration-dotted underline-offset-4 hover:decoration-solid"
                title="Go to selection"
              >
                {footerText}
              </button>
            )}
          </div>
          {selectedSlots.length > 0 && (
            <ul
              className="flex flex-wrap items-center gap-1.5"
              aria-label="Picked times"
            >
              {groupSelectedIntoSessions(selectedSlots, gridZone).map(
                (session) => {
                  const label = `${formatDayLabel(session.start, { zone: gridZone })} · ${formatClockTime(session.start, { zone: gridZone })}–${formatClockTime(session.end, { zone: gridZone })}`;
                  return (
                    <li
                      key={`${session.start.toISOString()}/${session.end.toISOString()}`}
                      title={label}
                      className="rounded-full border border-emerald-700/40 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-900"
                    >
                      {label}
                    </li>
                  );
                },
              )}
            </ul>
          )}
          {quota && (
            <span className="rounded-full border border-slate-400 px-2 py-0.5 text-xs text-slate-700">
              {quotaFooterText(quota, gridZone)}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
          {footerZone.limits && (
            <span title={footerZone.limits.title}>
              {footerZone.limits.label}
            </span>
          )}
          {freshness.label && (
            <span
              className={cn(
                "font-medium",
                freshness.failed || freshness.freshness === "stale"
                  ? "text-red-700 dark:text-red-400"
                  : "text-amber-800 dark:text-amber-400",
              )}
              title={
                freshness.failed
                  ? "The background refresh is failing. The times shown are the last ones that loaded — reload or try again in a moment."
                  : "This calendar refreshes about once a minute. Times are re-checked when you save them, so an old view can cost a click but cannot double-book."
              }
            >
              {freshness.label}
            </span>
          )}
        </div>
      </div>

      {showAllocationButtons && mode === "allocate" && (
        <div className="mt-2 flex shrink-0 flex-wrap justify-end gap-2">
          {onClose && (
            <Button
              variant="outline"
              size="sm"
              onClick={onClose}
              disabled={isAllocating}
            >
              Cancel
            </Button>
          )}
          <Button
            variant="default"
            size="sm"
            onClick={() => autoAllocate(availableSlots)}
            disabled={isAllocating}
            title={
              isAllocating
                ? "Saving times — wait for the current attempt to finish."
                : "Automatically place every session on free times."
            }
          >
            <Zap className="mr-2 h-4 w-4" />
            {eventType === "subscription"
              ? "Auto-schedule this week"
              : "Auto-schedule"}
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={() => void manualAllocate()}
            disabled={manualBlockedReason !== null}
            title={manualBlockedReason ?? "Save the picked times."}
          >
            <Users className="mr-2 h-4 w-4" />
            {isAllocating ? "Saving…" : "Save picked times"}
          </Button>
        </div>
      )}

      <AlertDialog
        open={!!partialOffer}
        onOpenChange={(open) => {
          if (!open) dismissPartialOffer();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Only {offer?.placeableSessions} of {offer?.requiredSessions}{" "}
              sessions fit
            </AlertDialogTitle>
            <AlertDialogDescription>
              {offer?.mode === "manual"
                ? "You picked times for "
                : "Your published availability in this period can hold "}
              {offer?.placeableSessions} session
              {offer?.placeableSessions === 1 ? "" : "s"}. Schedule those now
              and leave the remaining{" "}
              {(offer?.requiredSessions ?? 0) - (offer?.placeableSessions ?? 0)}{" "}
              pending? The client is told how many are booked, and you can
              schedule the rest later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isAllocating}>
              Not now
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={isAllocating}
              onClick={(event) => {
                // Stays under the hook's control so the retry reports into it.
                event.preventDefault();
                if (offer?.mode === "manual") {
                  void manualAllocate({ allowPartial: true });
                } else {
                  void autoAllocate(availableSlots, { allowPartial: true });
                }
              }}
            >
              Schedule {offer?.placeableSessions} now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
