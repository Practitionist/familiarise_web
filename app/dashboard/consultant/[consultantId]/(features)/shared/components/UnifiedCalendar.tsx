"use client";

import * as Sentry from "@sentry/nextjs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DAYS, INTERVALS } from "@/utils/timeSlotsMeta";
import { TWENTY_FOUR_HOURS_IN_MS } from "@/utils/slotAllocation/slotTimeUtils";
import { isRecurringEventType } from "@/utils/slotAllocation/types";
import {
  format,
  addDays,
  startOfWeek,
  endOfWeek,
  isSameDay,
  addWeeks,
  subWeeks,
  addMonths,
  subMonths,
} from "date-fns";
import {
  ChevronLeft,
  ChevronRight,
  Calendar,
  Clock,
  Users,
  Zap,
  RotateCcw,
} from "lucide-react";
import { useState, useEffect, useMemo, useCallback } from "react";
import {
  TimeSlot,
  AppointmentDetail,
  calculateRequiredSlots,
  calculateCallProgress,
  countSundayWeeksInclusive,
  validateDayBasedConsecutiveSlots,
} from "../utils/calendarUtils";
import { useCalendarData } from "../hooks/useCalendarData";
import { useEventSlotAllocation } from "../hooks/useSlotAllocation";
import type { AllocationResponse } from "../utils/allocationService";
import { SlotCalculationService } from "@/utils/slotAllocation/SlotCalculationService";
import {
  outsideSchedulingWindow,
  weeklyLimitReached,
  pastSlotBlocked,
  pastSessionBlocked,
  sessionTooSoon,
  sessionBeingRescheduled,
  slotUnavailable,
  notEnoughConsecutive,
} from "../utils/allocationMessages";
import { useToast } from "@/hooks/use-toast";

/**
 * Small pure helpers for clarity and reuse. These do not cause side effects.
 */
function getSlotsPerCall(sessionDurationInHours?: number): number {
  return Math.ceil((sessionDurationInHours || 1) / 0.5); // 30-min increments
}

/** Returns true if a UTC date is outside the [allowedStart, allowedEnd] bounds. */
function isOutsideAllowedRange(
  dateUtc: Date,
  allowedStart?: Date,
  allowedEnd?: Date,
): boolean {
  if (allowedStart && dateUtc < allowedStart) return true;
  if (allowedEnd && dateUtc > allowedEnd) return true;
  return false;
}

/** Returns true if a date (day-level) is within the allowed scheduling period. */
function isDateInSchedulingPeriod(
  date: Date,
  allowedStart?: Date,
  allowedEnd?: Date,
): boolean {
  if (!allowedStart && !allowedEnd) return false;

  // Compare at day level (ignore time)
  const dateOnly = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );
  const startOnly = allowedStart
    ? new Date(
        allowedStart.getFullYear(),
        allowedStart.getMonth(),
        allowedStart.getDate(),
      )
    : null;
  const endOnly = allowedEnd
    ? new Date(
        allowedEnd.getFullYear(),
        allowedEnd.getMonth(),
        allowedEnd.getDate(),
      )
    : null;

  if (startOnly && dateOnly < startOnly) return false;
  if (endOnly && dateOnly > endOnly) return false;
  return true;
}

/** Formats the allowed [start, end] range for user-facing messages. */
function formatAllowedRange(allowedStart?: Date, allowedEnd?: Date): string {
  const startText = allowedStart
    ? format(allowedStart, "MMM d, yyyy 'at' h:mm a")
    : "-";
  const endText = allowedEnd
    ? format(allowedEnd, "MMM d, yyyy 'at' h:mm a")
    : "-";
  return `${startText} – ${endText}`;
}

/**
 * Compares two TimeSlot arrays by content (not reference).
 * Used to prevent unnecessary state updates that cause infinite loops.
 */
function areSlotsEqual(slots1: TimeSlot[], slots2: TimeSlot[]): boolean {
  if (slots1.length !== slots2.length) return false;

  // Sort both arrays by startTime for consistent comparison
  const sorted1 = [...slots1].sort(
    (a, b) => a.startTime.getTime() - b.startTime.getTime(),
  );
  const sorted2 = [...slots2].sort(
    (a, b) => a.startTime.getTime() - b.startTime.getTime(),
  );

  return sorted1.every(
    (slot, index) =>
      slot.startTime.getTime() === sorted2[index].startTime.getTime(),
  );
}

/**
 * Counts completed calls from the user's current selection for a specific week.
 * A completed call is exactly `slotsPerCall` consecutive 30-min slots on the same day.
 */
function countCompletedSelectedCallsForWeek(
  selectedSlots: TimeSlot[],
  slotsPerCall: number,
  targetWeekKey: string,
  schedulingTimezone?: string,
): number {
  if (!selectedSlots?.length) return 0;

  // Group selected slots by scheduling-timezone day within the target week
  const byDay = new Map<string, TimeSlot[]>();
  for (const s of selectedSlots) {
    const start = s.startTime;
    if (
      SlotCalculationService.weekKey(start, schedulingTimezone) !==
      targetWeekKey
    )
      continue;
    const key = SlotCalculationService.dayKey(start, schedulingTimezone);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(s);
  }

  let completed = 0;
  byDay.forEach((daySlots) => {
    if (daySlots.length !== slotsPerCall) return;
    if (validateDayBasedConsecutiveSlots(daySlots, schedulingTimezone))
      completed += 1;
  });
  return completed;
}

/**
 * Subscription footer: Clear, action-oriented progress text
 * Removes confusing "past completed" concept and technical jargon
 */
function computeSubscriptionFooter(
  params: Readonly<{
    selectedSlots: TimeSlot[];
    allowedStart?: Date;
    allowedEnd?: Date;
    callsPerWeek?: number;
    sessionDurationInHours?: number;
    totalSessions?: number;
    pastCompletedSessions?: number;
  }>,
): string | null {
  const {
    selectedSlots,
    allowedStart,
    allowedEnd,
    callsPerWeek,
    sessionDurationInHours,
    totalSessions,
    pastCompletedSessions = 0,
  } = params;

  // Use totalSessions from plan (authoritative) to avoid calendar-week edge cases
  let maxTotalCalls: number;
  if (totalSessions && totalSessions > 0) {
    maxTotalCalls = totalSessions;
  } else {
    if (!allowedStart || !allowedEnd || !callsPerWeek) return null;
    const weeks = countSundayWeeksInclusive(allowedStart, allowedEnd);
    maxTotalCalls = weeks * callsPerWeek;
  }
  const slotsPerCall = getSlotsPerCall(sessionDurationInHours);
  const scheduled = Math.floor(selectedSlots.length / slotsPerCall);
  const totalScheduled = scheduled + pastCompletedSessions;
  const remaining = maxTotalCalls - totalScheduled;

  const duration = sessionDurationInHours || 1;
  const durationText = duration === 1 ? "1 hour" : `${duration} hours`;

  // Clear, user-friendly text based on progress
  if (pastCompletedSessions > 0 && scheduled === 0) {
    return `${pastCompletedSessions} past session${pastCompletedSessions !== 1 ? "s" : ""} completed | Schedule ${remaining} more (${durationText} each)`;
  } else if (pastCompletedSessions > 0 && remaining > 0) {
    return `✅ ${totalScheduled} of ${maxTotalCalls} (${pastCompletedSessions} past + ${scheduled} new) | ⏳ ${remaining} remaining`;
  } else if (scheduled === 0) {
    return `📅 Choose times for ${maxTotalCalls} sessions (${durationText} each)`;
  } else if (remaining > 0) {
    return `✅ ${scheduled} of ${maxTotalCalls} sessions scheduled • ${remaining} more to go`;
  } else {
    return `✅ All ${maxTotalCalls} sessions scheduled!`;
  }
}

/** Counts total completed class sessions across all selected slots. */
function countCompletedSelectedClasses(
  selectedSlots: TimeSlot[],
  slotsPerSession: number,
  schedulingTimezone?: string,
): number {
  if (!selectedSlots?.length) return 0;
  // Group by scheduling-timezone day and count full consecutive runs
  const byDay = new Map<string, TimeSlot[]>();
  for (const s of selectedSlots) {
    const key = SlotCalculationService.dayKey(s.startTime, schedulingTimezone);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(s);
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

/**
 * Class footer: Clear progress without technical jargon
 * Shows user-facing duration (hours) not implementation details (slots)
 */
function computeClassFooter(params: {
  selectedSlots: TimeSlot[];
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
  const slotsPerSession = Math.ceil((sessionDurationInHours || 1) / 0.5);
  const scheduled = countCompletedSelectedClasses(
    selectedSlots,
    slotsPerSession,
    schedulingTimezone,
  );
  const totalScheduled = scheduled + pastCompletedSessions;

  const duration = sessionDurationInHours || 1;
  const durationText = duration === 1 ? "1 hour" : `${duration} hours`;

  if (typeof totalSessions === "number" && totalSessions > 0) {
    const remaining = totalSessions - totalScheduled;

    if (pastCompletedSessions > 0 && scheduled === 0) {
      return `${pastCompletedSessions} past session${pastCompletedSessions !== 1 ? "s" : ""} completed | Schedule ${remaining} more (${durationText} each)`;
    } else if (remaining > 0) {
      return pastCompletedSessions > 0
        ? `✅ ${totalScheduled} of ${totalSessions} (${pastCompletedSessions} past + ${scheduled} new) | ⏳ ${remaining} remaining`
        : `✅ ${scheduled} scheduled | ⏳ ${remaining} remaining (${durationText} each)`;
    } else {
      return `✅ All ${totalSessions} sessions scheduled`;
    }
  }

  // Fallback when total not known
  return `Sessions scheduled: ${totalScheduled}`;
}

export interface UnifiedCalendarProps {
  consultantId: string;
  eventType: "consultation" | "subscription" | "webinar" | "class";
  eventId?: string;
  durationInMonths?: number;
  durationInHours?: number; // For consultations/webinars
  callsPerWeek?: number;
  sessionDurationInHours?: number; // For subscriptions/classes - individual session duration
  mode: "view" | "select" | "allocate";
  onSlotsSelected?: (slots: TimeSlot[]) => void;
  onAllocationComplete?: (result: AllocationResponse) => void;
  /** Called when the server reports the event was already allocated in
   * another session (409) — host should close the dialog and refetch. */
  onAllocationConflict?: () => void;
  /** Reject allocations if the event already has confirmed slots (fresh
   * PENDING allocations only; reschedule hosts must not set this). */
  initialAllocation?: boolean;
  onClose?: () => void;
  showAllocationButtons?: boolean;
  preSelectedSlots?: TimeSlot[];
  requestedSlots?: TimeSlot[];
  className?: string;
  // Optional hard boundaries to restrict interactive selection
  allowedStart?: Date;
  allowedEnd?: Date;
  totalSessions?: number; // Authoritative session count from plan (overrides weeks × callsPerWeek)
  /** Event's scheduling timezone — defines the limit day/week buckets
   * (ADR B9). Defaults to Asia/Kolkata in the shared helpers. */
  schedulingTimezone?: string;
}

export function UnifiedCalendar({
  consultantId,
  eventType,
  durationInHours,
  sessionDurationInHours,
  eventId,
  durationInMonths,
  callsPerWeek,
  mode = "view",
  onSlotsSelected,
  onAllocationComplete,
  onAllocationConflict,
  initialAllocation,
  onClose,
  showAllocationButtons = false,
  preSelectedSlots = [],
  requestedSlots = [],
  className = "",
  allowedStart,
  allowedEnd,
  totalSessions,
  schedulingTimezone,
}: UnifiedCalendarProps) {
  const { toast } = useToast();
  // State
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [view, setView] = useState<"week" | "month">("week");
  const [browserTimezone, setBrowserTimezone] = useState("UTC");
  const [configWarning, setConfigWarning] = useState<string | null>(null);

  // Initialize timezone
  useEffect(() => {
    setBrowserTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);

  // Use calendar data hook
  const {
    consultantDetails,
    availableSlots,
    eventSlots,
    eventTentativeSlots = [],
    weeklyConfirmedCallCounts,
    loading,
    error,
    refetch,
    refetchEventSlots,
    refetchAvailability,
    getSlotStatusForInterval,
  } = useCalendarData({
    consultantId,
    eventType,
    eventId,
    currentDate,
    view,
    mode,
    allowedStart,
    allowedEnd,
    sessionDurationInHours,
  });

  // Wrap onAllocationComplete to refetch data before calling parent callback
  const handleAllocationSuccess = useCallback(
    async (result: AllocationResponse) => {
      try {
        // Refetch event slots (weeklyConfirmedCallCounts) and availability
        // (server-computed status grid/tooltips, #997 Phase 2) so newly
        // allocated slots appear correctly.
        await Promise.all([refetchEventSlots(), refetchAvailability()]);
      } catch (error) {
        Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "client" } });
        console.error(
          "Error refetching calendar data after allocation:",
          error,
        );
      }

      // Call parent callback
      onAllocationComplete?.(result);
    },
    [refetchEventSlots, refetchAvailability, onAllocationComplete],
  );

  // Count past confirmed event slots for in-progress recurring events
  const pastEventSlotCount = useMemo(() => {
    const now = new Date();
    return eventSlots.filter((s) => s.endTime <= now).length;
  }, [eventSlots]);

  // Slot allocation hook
  const {
    selectedSlots,
    setSelectedSlots,
    isAllocating,
    allocationError,
    isValid,
    validationErrors,
    requiredSlots,
    toggleSlot,
    clearSlots,
    isSlotSelected,
    manualAllocate,
    autoAllocate,
    allocateRequestedSlots,
    slotLimits,
  } = useEventSlotAllocation({
    eventType,
    eventId: eventId || "",
    consultantId,
    durationInMonths,
    durationInHours,
    callsPerWeek,
    sessionDurationInHours,
    startDate: allowedStart,
    endDate: allowedEnd,
    // Provide dynamic maxTotalCalls so validation/toasts show the real limit.
    // Prefer totalSessions from plan (authoritative) over calendar-week calculation.
    maxTotalCalls: isRecurringEventType(eventType)
      ? totalSessions && totalSessions > 0
        ? totalSessions
        : allowedStart && allowedEnd && callsPerWeek
          ? countSundayWeeksInclusive(allowedStart, allowedEnd) *
            (callsPerWeek || 1)
          : undefined
      : undefined,
    pastConfirmedSlotCount: isRecurringEventType(eventType)
      ? pastEventSlotCount
      : undefined,
    initialAllocation,
    schedulingTimezone,
    onSuccess: handleAllocationSuccess,
    onConflict: onAllocationConflict,
  });

  // PERFORMANCE: Pre-compute a Set of event slot timestamps (rounded to seconds)
  // for O(1) lookups. Replaces O(n) .some() scan that ran 336× per render.
  const eventSlotsSet = useMemo(
    () =>
      new Set(eventSlots.map((s) => Math.round(s.startTime.getTime() / 1000))),
    [eventSlots],
  );

  // This event's OWN tentative slots (being rescheduled). Rendered as a distinct
  // "Rescheduling" state — NOT the foreign "Booked" gray they used to fall into.
  const eventTentativeSlotsSet = useMemo(
    () =>
      new Set(
        eventTentativeSlots.map((s) =>
          Math.round(s.startTime.getTime() / 1000),
        ),
      ),
    [eventTentativeSlots],
  );

  // Initialize pre-selected slots
  // Compare by content to prevent infinite loops from parent re-renders creating new array references
  useEffect(() => {
    if (
      preSelectedSlots.length > 0 &&
      !areSlotsEqual(selectedSlots, preSelectedSlots)
    ) {
      setSelectedSlots(preSelectedSlots);
    }
  }, [preSelectedSlots, selectedSlots, setSelectedSlots]);

  // Call onSlotsSelected when selection changes
  useEffect(() => {
    if (mode === "select" && onSlotsSelected) {
      onSlotsSelected(selectedSlots);
    }
  }, [selectedSlots, mode, onSlotsSelected]);

  // Set warning banner if duration configuration is missing
  useEffect(() => {
    if (eventType === "consultation" || eventType === "webinar") {
      if (!durationInHours || durationInHours <= 0) {
        setConfigWarning(
          `${eventType === "consultation" ? "Consultation" : "Webinar"} duration not configured. Using 1-hour default.`,
        );
      } else {
        setConfigWarning(null);
      }
    } else if (isRecurringEventType(eventType)) {
      if (!sessionDurationInHours || sessionDurationInHours <= 0) {
        setConfigWarning(
          `${eventType === "subscription" ? "Session" : "Class"} duration not configured. Using 1-hour default.`,
        );
      } else {
        setConfigWarning(null);
      }
    }
  }, [eventType, durationInHours, sessionDurationInHours]);

  // Week view dates. Deliberately LOCAL time: the grid renders in the
  // consultant's timezone. Limit BUCKETING is UTC (SlotCalculationService) —
  // do not "unify" these; display and bucketing are different concerns.
  const weekDates = useMemo(() => {
    const startDate = startOfWeek(currentDate);
    return [...Array(7)].map((_, i) => addDays(startDate, i));
  }, [currentDate]);

  /**
   * Builds an auto-expanded group of consecutive slots starting from a clicked slot.
   * Strategy: forward → backward → mixed → fallback to single slot.
   */
  const buildAutoExpandGroup = useCallback(
    (clickedSlot: TimeSlot, clickedDate: Date): TimeSlot[] => {
      const targetSize = slotLimits.slotsPerSession;

      // No expansion needed for single-slot sessions
      if (!targetSize || targetSize <= 1) return [clickedSlot];

      const clickedLocalStart = new Date(clickedSlot.startTime);

      // Check if a candidate slot at a given offset is eligible for auto-expansion
      const getEligibleSlot = (offsetSteps: number): TimeSlot | null => {
        const offsetMs = offsetSteps * 30 * 60 * 1000;
        const targetTime = new Date(clickedLocalStart.getTime() + offsetMs);

        // Same-day constraint in the event's scheduling timezone — a session
        // must not straddle the limit-bucket day boundary (ADR B9).
        if (
          SlotCalculationService.dayKey(targetTime, schedulingTimezone) !==
          SlotCalculationService.dayKey(clickedLocalStart, schedulingTimezone)
        )
          return null;

        const interval = {
          hour: targetTime.getHours(),
          minute: targetTime.getMinutes(),
        };
        const status = getSlotStatusForInterval(interval, clickedDate);

        // Must be available, not booked, not in past
        if (!status.isAvailable || status.isBookedForDisplay || status.isInPast)
          return null;

        // Must not be already selected
        const candidateStartMs = new Date(
          status.intervalStartUTCString,
        ).getTime();
        if (
          selectedSlots.some((s) => s.startTime.getTime() === candidateStartMs)
        )
          return null;

        // Must be within allowed range
        if (allowedStart || allowedEnd) {
          const intervalStart = new Date(status.intervalStartUTCString);
          if (allowedStart && intervalStart < allowedStart) return null;
          if (allowedEnd && intervalStart >= allowedEnd) return null;
        }

        return {
          startTime: new Date(status.intervalStartUTCString),
          endTime: new Date(status.intervalEndUTCString),
          isAvailable: status.isAvailable,
          isBooked: status.isBooked,
        };
      };

      // Try forward expansion: clicked + N-1 forward slots
      const forwardGroup: TimeSlot[] = [clickedSlot];
      for (let step = 1; step < targetSize; step++) {
        const eligible = getEligibleSlot(step);
        if (!eligible) break;
        forwardGroup.push(eligible);
      }
      if (forwardGroup.length === targetSize) return forwardGroup;

      // Try backward expansion: N-1 backward slots + clicked
      const backwardGroup: TimeSlot[] = [clickedSlot];
      for (let step = 1; step < targetSize; step++) {
        const eligible = getEligibleSlot(-step);
        if (!eligible) break;
        backwardGroup.unshift(eligible);
      }
      if (backwardGroup.length === targetSize) return backwardGroup;

      // Try mixed: use forward slots + fill remaining from backward
      if (forwardGroup.length > 1 || backwardGroup.length > 1) {
        const mixedGroup: TimeSlot[] = [...forwardGroup];
        for (let step = 1; mixedGroup.length < targetSize; step++) {
          const eligible = getEligibleSlot(-step);
          if (!eligible) break;
          mixedGroup.unshift(eligible);
        }
        if (mixedGroup.length === targetSize) return mixedGroup;
      }

      // Fallback: single slot (degrades to manual selection)
      return [clickedSlot];
    },
    [
      slotLimits.slotsPerSession,
      getSlotStatusForInterval,
      selectedSlots,
      allowedStart,
      allowedEnd,
      schedulingTimezone,
    ],
  );

  // Handle slot click
  const handleSlotClick = useCallback(
    (interval: { hour: number; minute: number }, date: Date) => {
      if (mode === "view") return;

      const status = getSlotStatusForInterval(interval, date);

      const slot: TimeSlot = {
        startTime: new Date(status.intervalStartUTCString),
        endTime: new Date(status.intervalEndUTCString),
        isAvailable: status.isAvailable,
        isBooked: status.isBooked,
      };

      // Check if this slot belongs to the current event — O(1) via Set lookup
      const isCurrentEventSlot = eventSlotsSet.has(
        Math.round(slot.startTime.getTime() / 1000),
      );
      // This event's own slot currently being rescheduled (tentative).
      const isCurrentEventTentative = eventTentativeSlotsSet.has(
        Math.round(slot.startTime.getTime() / 1000),
      );

      // First-line guard: allow click but block selection with feedback if outside allowed range
      if (allowedStart || allowedEnd) {
        const intervalStart = new Date(status.intervalStartUTCString);
        if (isOutsideAllowedRange(intervalStart, allowedStart, allowedEnd)) {
          toast(
            outsideSchedulingWindow(
              formatAllowedRange(allowedStart, allowedEnd),
            ),
          );
          return;
        }
      }
      // Weekly limit guard for subscriptions: fire on FIRST slot of a new day.
      // Bucketed by the event's scheduling-timezone week (ADR B9) — the SAME
      // definition the server validates with.
      if (
        eventType === "subscription" &&
        eventId &&
        callsPerWeek &&
        sessionDurationInHours
      ) {
        const intervalStart = new Date(status.intervalStartUTCString);
        const targetDayKey = SlotCalculationService.dayKey(
          intervalStart,
          schedulingTimezone,
        );
        const isStartingNewDay = !selectedSlots.some(
          (s) =>
            SlotCalculationService.dayKey(s.startTime, schedulingTimezone) ===
            targetDayKey,
        );

        if (isStartingNewDay) {
          const targetWeekKey = SlotCalculationService.weekKey(
            intervalStart,
            schedulingTimezone,
          );
          const slotsPerCall = getSlotsPerCall(sessionDurationInHours);
          // #997 Phase 3 — server-precomputed confirmed-call count for this
          // week (bucketed with the SAME SlotCalculationService.weekKey the
          // server validator uses), fetched alongside eventSlots. Replaces
          // re-deriving this from a separate whole-window appointment fetch
          // on every slot click.
          const completedCalls = weeklyConfirmedCallCounts[targetWeekKey] || 0;

          // Also include already selected complete calls in this same week
          const selectedCompleted = countCompletedSelectedCallsForWeek(
            selectedSlots,
            slotsPerCall,
            targetWeekKey,
            schedulingTimezone,
          );
          const totalCompletedThisWeek = completedCalls + selectedCompleted;

          // callsPerWeek is guaranteed truthy by the enclosing guard
          if (totalCompletedThisWeek >= callsPerWeek) {
            toast(weeklyLimitReached(callsPerWeek));
            return;
          }
        }
      }

      // Past "This Event" slots: allow deselection, block re-selection
      if (isCurrentEventSlot && status.isInPast) {
        const isCurrentlySelected = selectedSlots.some(
          (s) => s.startTime.getTime() === slot.startTime.getTime(),
        );
        if (isCurrentlySelected) {
          toggleSlot(slot);
          return;
        }
        toast(pastSessionBlocked());
        return;
      }

      // Imminent "This Event" slots (<24h away): block deselection
      if (isCurrentEventSlot && !status.isInPast) {
        const now = new Date();
        const imminentCutoff = new Date(
          now.getTime() + TWENTY_FOUR_HOURS_IN_MS,
        );
        if (slot.startTime < imminentCutoff) {
          toast(sessionTooSoon());
          return;
        }
      }

      // Block selection of unavailable, booked, or past non-event slots
      if (status.isInPast) {
        toast(pastSlotBlocked());
        return;
      }

      // This event's own tentative slot (being rescheduled) — NOT a foreign
      // booking. Don't show "already booked"; guide the consultant to pick a new
      // time. The old slot is freed when the re-allocation completes.
      if (isCurrentEventTentative) {
        toast(sessionBeingRescheduled());
        return;
      }

      // Allow current event slots to be toggled for rescheduling
      if (
        !isCurrentEventSlot &&
        (!status.isAvailable || status.isBookedForDisplay)
      ) {
        toast(slotUnavailable(Boolean(status.isBookedForDisplay)));
        return;
      }

      if (mode === "select" || mode === "allocate") {
        const isCurrentlySelected = selectedSlots.some(
          (s) => s.startTime.getTime() === slot.startTime.getTime(),
        );

        if (isCurrentlySelected) {
          // Deselect: hook's REMOVE path handles consecutive group detection
          toggleSlot(slot);
        } else {
          // Add: build auto-expanded consecutive group
          const expandedGroup = buildAutoExpandGroup(slot, date);

          // Block selection if we can't find enough consecutive slots for a complete session
          const requiredSlots = slotLimits.slotsPerSession;
          if (requiredSlots > 1 && expandedGroup.length < requiredSlots) {
            toast(notEnoughConsecutive(requiredSlots, expandedGroup.length));
            return;
          }

          toggleSlot(slot, expandedGroup);
        }
      }
    },
    [
      mode,
      getSlotStatusForInterval,
      toggleSlot,
      buildAutoExpandGroup,
      slotLimits,
      // Dependencies used inside the callback
      eventType,
      eventId,
      callsPerWeek,
      sessionDurationInHours,
      schedulingTimezone,
      allowedStart,
      allowedEnd,
      selectedSlots,
      weeklyConfirmedCallCounts,
      eventSlotsSet,
      eventTentativeSlotsSet,
      toast,
    ],
  );

  // Render time cell
  const renderTimeCell = useCallback(
    (interval: { hour: number; minute: number }, date: Date) => {
      const status = getSlotStatusForInterval(interval, date);

      const slot: TimeSlot = {
        startTime: new Date(status.intervalStartUTCString),
        endTime: new Date(status.intervalEndUTCString),
        isAvailable: status.isAvailable,
        isBooked: status.isBooked,
      };

      const isCurrentlySelected = isSlotSelected(slot);

      // Check if this slot belongs to the current event — O(1) via Set lookup
      const isCurrentEventSlot = eventSlotsSet.has(
        Math.round(slot.startTime.getTime() / 1000),
      );
      // This event's own slot being rescheduled (tentative) — distinct state.
      const isCurrentEventTentative = eventTentativeSlotsSet.has(
        Math.round(slot.startTime.getTime() / 1000),
      );

      // Check if slot is outside allowed period for subscriptions/classes
      const intervalStart = new Date(status.intervalStartUTCString);
      const intervalEnd = new Date(status.intervalEndUTCString);
      const isOutsideAllowedRange =
        (allowedStart && intervalEnd <= allowedStart) ||
        (allowedEnd && intervalStart >= allowedEnd);

      // Fast-exit: avoid rendering a clickable button for cells that have no
      // availability **and** are disabled (e.g. past date).  Rendering a
      // lightweight placeholder saves performance.
      if (!status.isAvailable && !status.isBooked && status.isInPast) {
        return (
          <div className="h-8 w-full bg-gray-100 border border-gray-200 rounded-sm" />
        );
      }

      let cellClassName =
        "h-8 w-full relative transition-colors duration-75 ease-in-out border border-transparent rounded-sm text-[10px] leading-tight px-1 py-0.5 disabled:pointer-events-none disabled:opacity-50";
      let buttonText = "";
      const showTooltip =
        ((status.isBookedForDisplay || status.isPartiallyBooked) &&
          status.overlappingAppointments.length > 0) ||
        isCurrentEventSlot;

      if (isCurrentlySelected) {
        // Dark green for manually selected slots
        cellClassName +=
          " bg-green-700 text-white hover:bg-green-800 border-green-900";
        buttonText = "Selected";
      } else if (isCurrentEventSlot) {
        // Black for this event's already booked slots
        cellClassName +=
          " bg-black text-white cursor-pointer hover:bg-gray-900 border-gray-800";
        cellClassName += status.isInPast ? " opacity-60" : "";
        buttonText = status.isInPast ? "Past Session" : "This Event";
      } else if (isCurrentEventTentative) {
        // Amber for THIS event's slot being rescheduled — distinct from the gray
        // "Booked" used for foreign appointments. It's the consultant's own slot
        // pending a new time, not someone else's booking.
        cellClassName +=
          " bg-amber-400 text-amber-900 cursor-pointer hover:bg-amber-500 border-amber-500";
        cellClassName += status.isInPast ? " opacity-50" : "";
        buttonText = "Rescheduling";
      } else if (status.isBookedForDisplay) {
        // Grey for other appointments
        cellClassName +=
          " bg-slate-400 text-slate-800 cursor-pointer hover:bg-slate-500";
        cellClassName += status.isInPast ? " opacity-50" : "";
        buttonText = "Booked";
      } else if (status.isPartiallyBooked) {
        cellClassName +=
          " bg-yellow-400 text-yellow-900 cursor-pointer hover:bg-yellow-500";
        cellClassName += status.isInPast ? " opacity-50" : "";
        buttonText = "Partially Booked";
      } else if (status.isAvailable) {
        // Available slot - check if past for fading
        if (status.isInPast) {
          // Past available slot - faded, clickable (shows toast)
          cellClassName +=
            " bg-green-300 text-green-950 opacity-50 cursor-pointer hover:bg-green-400 border-green-400";
          buttonText = isOutsideAllowedRange ? "Outside Period" : "Available";
        } else {
          // Future available slot - unfaded, clickable
          cellClassName +=
            " bg-green-300 text-green-950 cursor-pointer hover:bg-green-400 border-green-400";
          if (eventType === "consultation") {
            cellClassName += " hover:shadow-md";
          }
          buttonText = isOutsideAllowedRange ? "Outside Period" : "Available";
        }
      } else {
        if (status.isInPast) {
          cellClassName +=
            " bg-gray-300 text-gray-700 cursor-not-allowed opacity-70";
        } else {
          cellClassName += " bg-slate-200 cursor-not-allowed";
        }
      }

      // Only disable in view mode or if no availability at all (gray slots)
      const isButtonDisabled =
        mode === "view" || (!status.isAvailable && !status.isBooked);

      const buttonElement = (
        <button
          type="button"
          className={cellClassName}
          onClick={() => handleSlotClick(interval, date)}
          disabled={isButtonDisabled}
        >
          {buttonText}
        </button>
      );

      if (showTooltip) {
        return (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>{buttonElement}</TooltipTrigger>
              <TooltipContent
                className="max-w-xs text-xs"
                side="top"
                align="center"
              >
                <div className="flex flex-col gap-1">
                  {isCurrentEventSlot ? (
                    // Show current event details
                    <div>
                      <p className="font-semibold">This Event&apos;s Slot</p>
                      <p className="text-muted-foreground">
                        {eventType === "consultation"
                          ? "Consultation"
                          : eventType === "subscription"
                            ? "Subscription"
                            : eventType === "webinar"
                              ? "Webinar"
                              : "Class"}
                      </p>
                      <p className="text-muted-foreground text-[10px] mt-1">
                        {status.isInPast
                          ? "Past session (completed)"
                          : "Click to reschedule"}
                      </p>
                    </div>
                  ) : (
                    // Show overlapping appointments
                    status.overlappingAppointments.map(
                      (appSlot: AppointmentDetail, index: number) => (
                        <div
                          key={`${appSlot.id}-${index}`}
                          className="border-b border-border last:border-b-0 pb-1 mb-1 last:pb-0 last:mb-0"
                        >
                          <p className="font-semibold">{appSlot.title}</p>
                          <p className="text-muted-foreground">
                            {appSlot.type}
                          </p>
                          {appSlot.with && (
                            <p className="text-muted-foreground">
                              with {appSlot.with}
                            </p>
                          )}
                        </div>
                      ),
                    )
                  )}
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        );
      }

      return buttonElement;
    },
    [
      getSlotStatusForInterval,
      isSlotSelected,
      handleSlotClick,
      mode,
      allowedStart,
      allowedEnd,
      eventType,
      eventSlotsSet,
      eventTentativeSlotsSet,
    ],
  );

  // Render month view
  const renderMonthView = useCallback(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDayOfMonth = new Date(year, month, 1).getDay();
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const countAvailableSlotsForDay = (date: Date): number => {
      let count = 0;
      for (const interval of INTERVALS) {
        const status = getSlotStatusForInterval(interval, date);
        if (status.isAvailable && !status.isInPast) {
          count++;
        }
      }
      return count;
    };

    return (
      <div className="grid grid-cols-7 gap-1 flex-1 min-h-0 max-h-[min(600px,calc(90dvh_-_16rem))] overflow-y-auto">
        {DAYS.map((day) => (
          <div key={day} className="text-center font-bold p-2">
            {day.slice(0, 3)}
          </div>
        ))}
        {Array.from({ length: firstDayOfMonth }, (_, i) => (
          <div
            key={`empty-start-${i}`}
            className="min-h-[100px] border bg-gray-50/50"
          />
        ))}
        {Array.from(
          { length: new Date(year, month + 1, 0).getDate() },
          (_, i) => {
            const date = new Date(year, month, i + 1);
            const isCurrentDay = isSameDay(date, now);
            const isPastDay = date < today;
            const availableCount = isPastDay
              ? 0
              : countAvailableSlotsForDay(date);

            return (
              <div
                key={date.toISOString()}
                className={`min-h-[100px] border p-1 flex flex-col ${
                  isCurrentDay ? "ring-2 ring-primary" : ""
                } ${isPastDay ? "bg-gray-100 text-gray-400" : "bg-white"}`}
              >
                <div
                  className={`font-bold mb-1 text-xs ${
                    isCurrentDay ? "text-primary" : ""
                  } ${isPastDay ? "" : "text-gray-700"}`}
                >
                  {i + 1}
                </div>
                <div className="flex-grow flex items-center justify-center">
                  {!isPastDay && availableCount > 0 && (
                    <Badge variant="outline" className="text-[10px] p-1">
                      {availableCount} slots
                    </Badge>
                  )}
                  {!isPastDay && availableCount === 0 && (
                    <span className="text-xs text-muted-foreground">
                      No Slots
                    </span>
                  )}
                </div>
              </div>
            );
          },
        )}
      </div>
    );
  }, [currentDate, getSlotStatusForInterval]);

  // Loading state
  if (loading) {
    return (
      <div className={`flex items-center justify-center p-8 ${className}`}>
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
        <span className="ml-2">Loading calendar...</span>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className={`bg-red-50 p-4 rounded-md text-red-700 ${className}`}>
        <p>Error loading calendar: {error}</p>
        <Button variant="outline" size="sm" onClick={refetch} className="mt-2">
          <RotateCcw className="h-4 w-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  // No consultant data
  if (!consultantDetails) {
    return (
      <div className={`text-center p-8 text-muted-foreground ${className}`}>
        <Calendar className="h-12 w-12 mx-auto mb-4 opacity-50" />
        <p>No calendar data available</p>
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-4 min-h-0 ${className}`}>
      {/* Warning Banner */}
      {configWarning && (
        <div className="shrink-0 rounded-md bg-yellow-50 border border-yellow-200 px-4 py-3">
          <div className="flex items-start">
            <span className="text-yellow-600 mr-2">⚠️</span>
            <div className="flex-1">
              <p className="text-sm font-medium text-yellow-800">
                Using Default Value
              </p>
              <p className="text-sm text-yellow-700">{configWarning}</p>
            </div>
          </div>
        </div>
      )}

      {/* Scheduling Period Info Banner */}
      {allowedStart && allowedEnd && (
        <div className="shrink-0 rounded-md bg-blue-50 border border-blue-200 px-4 py-3">
          <div className="flex items-start">
            <Calendar className="h-5 w-5 text-blue-600 mr-2 flex-shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-blue-800">
                Scheduling Period
              </p>
              <p className="text-sm text-blue-700">
                {formatAllowedRange(allowedStart, allowedEnd)}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="shrink-0 flex flex-wrap items-center justify-between gap-2 sm:gap-4">
        <div className="flex gap-2">
          <Button
            variant={view === "week" ? "default" : "outline"}
            size="sm"
            onClick={() => setView("week")}
          >
            Week
          </Button>
          <Button
            variant={view === "month" ? "default" : "outline"}
            size="sm"
            onClick={() => setView("month")}
          >
            Month
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
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
              ? `${format(startOfWeek(currentDate), "MMM d")} - ${format(endOfWeek(currentDate), "MMM d, yyyy")}`
              : format(currentDate, "MMMM yyyy")}
          </div>
          <Button
            variant="outline"
            size="sm"
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
        </div>

        {showAllocationButtons && mode === "allocate" ? (
          <Button
            variant="outline"
            size="sm"
            onClick={clearSlots}
            disabled={isAllocating || selectedSlots.length === 0}
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            Clear Selection
          </Button>
        ) : (
          <div className="hidden w-20 sm:block"></div>
        )}
      </div>

      {/* Calendar View */}
      {view === "week" ? (
        <div className="flex flex-col flex-1 min-h-0 max-h-[min(500px,calc(90dvh_-_16rem))]">
          {/* Week header */}
          <div className="shrink-0 grid grid-cols-8 gap-0.5 md:gap-1 bg-background z-20 pb-1">
            <div className="w-14 md:w-20"></div>
            {weekDates.map((date, index) => {
              const isToday = isSameDay(date, new Date());
              const isInPeriod = isDateInSchedulingPeriod(
                date,
                allowedStart,
                allowedEnd,
              );
              return (
                <div
                  key={DAYS[index]}
                  className={`text-center p-1 md:p-2 ${
                    isInPeriod ? "bg-blue-50 border-x-2 border-blue-200" : ""
                  }`}
                >
                  <div
                    className={`font-bold text-xs md:text-base ${
                      isToday ? "text-primary" : ""
                    }`}
                  >
                    {DAYS[index].slice(0, 3)}
                  </div>
                  <div className="text-xs md:text-sm text-muted-foreground">
                    {format(date, "d")}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Week grid */}
          <div className="flex-1 overflow-y-auto scrollbar-thin min-h-0">
            {INTERVALS.map((interval) => (
              <div
                key={`interval-row-${interval.hour}-${interval.minute}`}
                className="grid grid-cols-8 gap-0.5 md:gap-1"
              >
                <div className="w-14 md:w-20">
                  <div className="h-8 text-right pr-2 pt-0.5 text-[10px] md:text-sm flex items-start justify-end">
                    {new Date(
                      1970,
                      0,
                      1,
                      interval.hour,
                      interval.minute,
                    ).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    })}
                  </div>
                </div>
                {weekDates.map((date) => (
                  <div key={date.toISOString()} className="col-span-1">
                    {renderTimeCell(interval, date)}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : (
        renderMonthView()
      )}

      {/* Footer */}
      <div className="shrink-0 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="flex flex-wrap items-center gap-2 sm:gap-4">
          <div className="text-sm">
            {(() => {
              try {
                if (eventType === "subscription") {
                  const slotsPerCall = getSlotsPerCall(sessionDurationInHours);
                  const computed = computeSubscriptionFooter({
                    selectedSlots,
                    allowedStart,
                    allowedEnd,
                    callsPerWeek,
                    sessionDurationInHours,
                    totalSessions,
                    pastCompletedSessions:
                      pastEventSlotCount > 0
                        ? Math.floor(pastEventSlotCount / slotsPerCall)
                        : 0,
                  });
                  if (computed) return computed;
                  // Fallback to existing text if boundaries not provided
                  return calculateCallProgress(
                    selectedSlots,
                    sessionDurationInHours,
                    slotLimits.maxSlots,
                    schedulingTimezone,
                  );
                } else if (eventType === "class") {
                  const slotsPerSession = Math.ceil(
                    (sessionDurationInHours || 1) / 0.5,
                  );
                  return computeClassFooter({
                    selectedSlots,
                    sessionDurationInHours,
                    totalSessions: slotLimits.totalSessions,
                    pastCompletedSessions:
                      pastEventSlotCount > 0
                        ? Math.floor(pastEventSlotCount / slotsPerSession)
                        : 0,
                    schedulingTimezone,
                  });
                }

                const duration =
                  eventType === "consultation" || eventType === "webinar"
                    ? durationInHours
                    : sessionDurationInHours;

                const requiredSlotsForThisEvent = calculateRequiredSlots(
                  eventType,
                  durationInMonths,
                  callsPerWeek,
                  duration,
                );

                return `${selectedSlots.length} selected out of ${requiredSlotsForThisEvent} required slots`;
              } catch (error) {
                Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "client" } });
                console.error("Error calculating footer stats:", error);
                if (error instanceof Error) {
                  return error.message;
                }
                return `Selected: ${selectedSlots.length} slots`;
              }
            })()}
          </div>
          {/* Only show weekly limit for subscriptions - other event types don't need secondary info */}
          {eventType === "subscription" && (
            <div className="text-xs text-muted-foreground">
              Max {callsPerWeek || 1} session
              {(callsPerWeek || 1) > 1 ? "s" : ""} per week
            </div>
          )}
          {allocationError && (
            <div className="text-sm text-red-600">{allocationError}</div>
          )}
        </div>

        <div className="text-sm text-muted-foreground">
          Timezone: {browserTimezone}
        </div>
      </div>

      {/* Allocation Buttons - Bottom */}
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
          >
            <Zap className="h-4 w-4 mr-2" />
            Auto Allocate
          </Button>

          {requestedSlots.length > 0 && (
            <Button
              variant="default"
              size="sm"
              onClick={() => allocateRequestedSlots(requestedSlots)}
              disabled={isAllocating}
            >
              <Clock className="h-4 w-4 mr-2" />
              Use Requested Times
            </Button>
          )}

          <Button
            variant="default"
            size="sm"
            onClick={() => manualAllocate()}
            disabled={
              isAllocating ||
              !isValid ||
              selectedSlots.length === 0 ||
              selectedSlots.length !== requiredSlots
            }
            title={
              !isValid
                ? `Invalid selection: ${validationErrors.join(", ")}`
                : selectedSlots.length === 0
                  ? "Please select slots first"
                  : selectedSlots.length !== requiredSlots
                    ? `Need ${requiredSlots} slots, but ${selectedSlots.length} selected`
                    : "Allocate the selected slots"
            }
          >
            <Users className="h-4 w-4 mr-2" />
            {isAllocating ? "Allocating..." : "Allocate Manual Slots"}
          </Button>
        </div>
      )}
    </div>
  );
}
