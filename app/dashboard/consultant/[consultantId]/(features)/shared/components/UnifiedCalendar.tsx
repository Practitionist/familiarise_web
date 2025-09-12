"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DAYS, INTERVALS } from "@/utils/timeSlotsMeta";
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
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
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
import { AllocationConfirmationDialog } from "./AllocationConfirmationDialog";
// Note: remove unused imports to keep the component lean
import { useToast } from "@/hooks/use-toast";

/**
 * Small pure helpers for clarity and reuse. These do not cause side effects.
 */

/**
 * Converts session duration in hours to number of 30-minute slots required.
 *
 * @param sessionDurationInHours - Duration in hours (e.g., 1.5, 2, 0.5)
 * @returns Number of 30-minute slots needed
 *
 * @example
 * getSlotsPerCall(1)    // Returns 2 (1 hour = 2 slots)
 * getSlotsPerCall(1.5)  // Returns 3 (1.5 hours = 3 slots)
 * getSlotsPerCall(2)    // Returns 4 (2 hours = 4 slots)
 * getSlotsPerCall(0.5)  // Returns 1 (30 minutes = 1 slot)
 */
function getSlotsPerCall(sessionDurationInHours?: number): number {
  return Math.ceil((sessionDurationInHours || 1) / 0.5); // 30-min increments
}

/**
 * Returns true if a UTC date is outside the [allowedStart, allowedEnd] bounds.
 *
 * @param dateUtc - The date to check (in UTC)
 * @param allowedStart - Optional start boundary (inclusive)
 * @param allowedEnd - Optional end boundary (inclusive)
 * @returns true if date is outside the allowed range
 *
 * @example
 * const date = new Date('2024-01-15T10:00:00Z');
 * const start = new Date('2024-01-01T00:00:00Z');
 * const end = new Date('2024-01-31T23:59:59Z');
 *
 * isOutsideAllowedRange(date, start, end)  // false (within range)
 * isOutsideAllowedRange(date, start)       // false (only start check)
 * isOutsideAllowedRange(date, undefined, end) // false (only end check)
 * isOutsideAllowedRange(new Date('2024-02-01'), start, end) // true (after end)
 */
function isOutsideAllowedRange(
  dateUtc: Date,
  allowedStart?: Date,
  allowedEnd?: Date
): boolean {
  if (allowedStart && dateUtc < allowedStart) return true;
  if (allowedEnd && dateUtc > allowedEnd) return true;
  return false;
}

/**
 * Formats the allowed [start, end] range for user-facing messages.
 *
 * @param allowedStart - Optional start date
 * @param allowedEnd - Optional end date
 * @returns Formatted string for display
 *
 * @example
 * formatAllowedRange(
 *   new Date('2024-01-01T00:00:00Z'),
 *   new Date('2024-01-31T23:59:59Z')
 * ) // Returns "1/1/2024, 12:00:00 AM – 1/31/2024, 11:59:59 PM"
 *
 * formatAllowedRange(undefined, new Date()) // Returns "- – 1/15/2024, 2:30:00 PM"
 * formatAllowedRange() // Returns "- – -"
 */
function formatAllowedRange(allowedStart?: Date, allowedEnd?: Date): string {
  const startText = allowedStart ? allowedStart.toLocaleString() : "-";
  const endText = allowedEnd ? allowedEnd.toLocaleString() : "-";
  return `${startText} – ${endText}`;
}

/**
 * Counts completed calls (appointments with a full slot block) for a given
 * subscription inside a specific week window.
 *
 * A "completed call" is defined as an appointment that:
 * 1. Is of type "SUBSCRIPTION"
 * 2. Belongs to the specified subscription
 * 3. Has exactly the required number of slots per call
 * 4. Starts within the specified week window
 *
 * @param existingAppointments - Array of all existing appointments
 * @param subscriptionId - ID of the subscription to count calls for
 * @param slotsPerCall - Expected number of slots per call (e.g., 2 for 1-hour calls)
 * @param weekStart - Start of the week (inclusive)
 * @param weekEnd - End of the week (inclusive)
 * @returns Number of completed calls in the week
 *
 * @example
 * const appointments = [
 *   { appointmentType: "SUBSCRIPTION", subscription: { id: "sub-123" }, slotsOfAppointment: [slot1, slot2] },
 *   { appointmentType: "SUBSCRIPTION", subscription: { id: "sub-123" }, slotsOfAppointment: [slot3] },
 *   { appointmentType: "CONSULTATION", slotsOfAppointment: [slot4, slot5] }
 * ];
 *
 * countCompletedCallsForWeek(appointments, "sub-123", 2, weekStart, weekEnd)
 * // Returns 1 (only the first appointment has exactly 2 slots and is a subscription)
 */
function countCompletedCallsForWeek(
  existingAppointments: any[],
  subscriptionId: string,
  slotsPerCall: number,
  weekStart: Date,
  weekEnd: Date
): number {
  if (!Array.isArray(existingAppointments)) return 0;

  return existingAppointments.filter((appt: any) => {
    if (appt.appointmentType !== "SUBSCRIPTION") return false;
    if (!appt.subscription || appt.subscription.id !== subscriptionId)
      return false;
    const slots = appt.slotsOfAppointment || [];
    // A completed call is an appointment that has exactly the per-call slot count
    if (slots.length !== slotsPerCall) return false;
    const start = new Date(slots[0].slotStartTimeInUTC);
    return start >= weekStart && start <= weekEnd;
  }).length;
}

/**
 * Counts completed calls from the user's current selection for a specific week.
 * A completed call is exactly `slotsPerCall` consecutive 30-min slots on the same day.
 *
 * This function helps validate that users haven't exceeded weekly call limits
 * when manually selecting slots for subscriptions.
 *
 * @param selectedSlots - Currently selected time slots by the user
 * @param slotsPerCall - Required slots per call (e.g., 2 for 1-hour calls)
 * @param weekStart - Start of the week to check (inclusive)
 * @param weekEnd - End of the week to check (inclusive)
 * @returns Number of completed calls in the selection for this week
 *
 * @example
 * const selectedSlots = [
 *   { startTime: new Date('2024-01-15T09:00:00Z'), endTime: new Date('2024-01-15T09:30:00Z') },
 *   { startTime: new Date('2024-01-15T09:30:00Z'), endTime: new Date('2024-01-15T10:00:00Z') }, // 1 complete call
 *   { startTime: new Date('2024-01-16T10:00:00Z'), endTime: new Date('2024-01-16T10:30:00Z') }  // incomplete call
 * ];
 *
 * countCompletedSelectedCallsForWeek(selectedSlots, 2, weekStart, weekEnd)
 * // Returns 1 (one complete 2-slot call on Jan 15th)
 */
function countCompletedSelectedCallsForWeek(
  selectedSlots: TimeSlot[],
  slotsPerCall: number,
  weekStart: Date,
  weekEnd: Date
): number {
  if (!selectedSlots?.length) return 0;

  // Group selected slots by day within the target week
  const byDay = new Map<string, TimeSlot[]>();
  for (const s of selectedSlots) {
    const start = s.startTime;
    if (start < weekStart || start > weekEnd) continue;
    const key = start.toDateString();
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(s);
  }

  let completed = 0;
  byDay.forEach((daySlots) => {
    if (daySlots.length !== slotsPerCall) return;
    if (validateDayBasedConsecutiveSlots(daySlots)) completed += 1;
  });
  return completed;
}

/**
 * Counts completed classes from existing appointments for a specific class.
 * Similar to countCompletedCallsForWeek but for classes.
 *
 * A "completed class session" is defined as an appointment that:
 * 1. Is of type "CLASS"
 * 2. Belongs to the specified class
 * 3. Has exactly the required number of slots per session
 * 4. Has fully ended in the past (not ongoing or future)
 *
 * @param existingAppointments - Array of all existing appointments
 * @param classId - ID of the class to count sessions for
 * @param slotsPerSession - Expected number of slots per session (e.g., 2 for 1-hour sessions)
 * @returns Number of completed class sessions
 *
 * @example
 * const appointments = [
 *   {
 *     appointmentType: "CLASS",
 *     class: { id: "class-123" },
 *     slotsOfAppointment: [
 *       { slotStartTimeInUTC: "2024-01-10T09:00:00Z", slotEndTimeInUTC: "2024-01-10T09:30:00Z" },
 *       { slotStartTimeInUTC: "2024-01-10T09:30:00Z", slotEndTimeInUTC: "2024-01-10T10:00:00Z" }
 *     ]
 *   },
 *   {
 *     appointmentType: "CLASS",
 *     class: { id: "class-123" },
 *     slotsOfAppointment: [
 *       { slotStartTimeInUTC: "2024-01-15T10:00:00Z", slotEndTimeInUTC: "2024-01-15T10:30:00Z" }
 *     ]
 *   }
 * ];
 *
 * countCompletedClassesForClass(appointments, "class-123", 2)
 * // Returns 1 (only the first appointment has exactly 2 slots and is completed)
 */
function countCompletedClassesForClass(
  existingAppointments: any[],
  classId: string,
  slotsPerSession: number
): number {
  if (!Array.isArray(existingAppointments)) return 0;

  return existingAppointments.filter((appt: any) => {
    if (appt.appointmentType !== "CLASS") return false;
    if (!appt.class || appt.class.id !== classId) return false;
    const slots = appt.slotsOfAppointment || [];
    // A completed class session is an appointment that has exactly the per-session slot count
    if (slots.length !== slotsPerSession) return false;
    // Check if the session has fully ended in the past
    const last = slots[slots.length - 1];
    const lastEnd = new Date(last.slotEndTimeInUTC || last.slotStartTimeInUTC);
    return lastEnd < new Date();
  }).length;
}

/**
 * Counts in-progress (started but not complete) selected calls for a week.
 *
 * An "in-progress call" is a day that has some selected slots but fewer than
 * the required slotsPerCall, indicating the user has started selecting a call
 * but hasn't completed it yet.
 *
 * @param selectedSlots - Currently selected time slots by the user
 * @param slotsPerCall - Required slots per call (e.g., 2 for 1-hour calls)
 * @param weekStart - Start of the week to check (inclusive)
 * @param weekEnd - End of the week to check (inclusive)
 * @returns Number of in-progress calls in the selection for this week
 *
 * @example
 * const selectedSlots = [
 *   { startTime: new Date('2024-01-15T09:00:00Z') }, // Incomplete call (only 1 slot)
 *   { startTime: new Date('2024-01-16T10:00:00Z') }, // Incomplete call (only 1 slot)
 *   { startTime: new Date('2024-01-17T11:00:00Z') }, // Incomplete call (only 1 slot)
 * ];
 *
 * _countInProgressSelectedCallsForWeek(selectedSlots, 2, weekStart, weekEnd)
 * // Returns 3 (three days with incomplete calls)
 */
function _countInProgressSelectedCallsForWeek(
  selectedSlots: TimeSlot[],
  slotsPerCall: number,
  weekStart: Date,
  weekEnd: Date
): number {
  if (!selectedSlots?.length) return 0;
  const byDay = new Map<string, TimeSlot[]>();
  for (const s of selectedSlots) {
    const start = s.startTime;
    if (start < weekStart || start > weekEnd) continue;
    const key = start.toDateString();
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(s);
  }

  // (moved down) countCompletedSelectedClasses / computeClassFooter helpers
  let started = 0;
  byDay.forEach((daySlots) => {
    if (daySlots.length === 0) return;
    if (daySlots.length < slotsPerCall) started += 1;
  });
  return started;
}

/**
 * Computes the dynamic footer text for subscriptions:
 * - Max calls derived from (weeks between start/end) × callsPerWeek
 * - Past fully elapsed weeks are counted as completed calls
 * - Currently selected consecutive slots add to completed calls
 */

/**
 * Counts completed calls across the entire subscription based on appointments.
 *
 * This function counts all completed subscription calls that have fully ended
 * in the past, regardless of which week they occurred in.
 *
 * @param existingAppointments - Array of all existing appointments
 * @param subscriptionId - ID of the subscription to count calls for
 * @param slotsPerCall - Expected number of slots per call (e.g., 2 for 1-hour calls)
 * @returns Total number of completed calls for the subscription
 *
 * @example
 * const appointments = [
 *   {
 *     appointmentType: "SUBSCRIPTION",
 *     subscription: { id: "sub-123" },
 *     slotsOfAppointment: [
 *       { slotStartTimeInUTC: "2024-01-01T09:00:00Z", slotEndTimeInUTC: "2024-01-01T10:00:00Z" }
 *     ]
 *   },
 *   {
 *     appointmentType: "SUBSCRIPTION",
 *     subscription: { id: "sub-123" },
 *     slotsOfAppointment: [
 *       { slotStartTimeInUTC: "2024-01-08T09:00:00Z", slotEndTimeInUTC: "2024-01-08T10:00:00Z" }
 *     ]
 *   }
 * ];
 *
 * countCompletedCallsForSubscription(appointments, "sub-123", 2)
 * // Returns 2 (both appointments are completed subscription calls)
 */
function countCompletedCallsForSubscription(
  existingAppointments: any[],
  subscriptionId: string,
  slotsPerCall: number
): number {
  if (!Array.isArray(existingAppointments)) return 0;
  return existingAppointments.filter((appt: any) => {
    if (appt.appointmentType !== "SUBSCRIPTION") return false;
    if (!appt.subscription || appt.subscription.id !== subscriptionId)
      return false;
    const slots = appt.slotsOfAppointment || [];
    if (slots.length !== slotsPerCall) return false;
    const last = slots[slots.length - 1];
    const lastEnd = new Date(last.slotEndTimeInUTC || last.slotStartTimeInUTC);
    return lastEnd < new Date();
  }).length;
}

/**
 * Calculate completed calls using week-based logic.
 *
 * This function implements a sophisticated week-by-week counting strategy:
 * 1. Past weeks: Assumes all calls were completed (optimistic approach)
 * 2. Current week: Counts actual completed appointments
 * 3. Future weeks: Counts nothing
 *
 * This approach provides a more accurate representation of subscription progress
 * by considering the natural weekly rhythm of subscription calls.
 *
 * @param subscriptionStart - When the subscription period begins
 * @param subscriptionEnd - When the subscription period ends
 * @param currentDate - Current date/time for determining past/current/future weeks
 * @param callsPerWeek - Number of calls expected per week
 * @param existingAppointments - All existing appointments to search through
 * @param subscriptionId - ID of the subscription to count calls for
 * @param slotsPerCall - Expected number of slots per call
 * @returns Number of completed calls using week-based logic
 *
 * @example
 * const subscriptionStart = new Date('2024-01-01T00:00:00Z');
 * const subscriptionEnd = new Date('2024-01-31T23:59:59Z');
 * const currentDate = new Date('2024-01-15T12:00:00Z');
 *
 * // Week 1 (Jan 1-7): Past week, assume 2 calls completed
 * // Week 2 (Jan 8-14): Past week, assume 2 calls completed
 * // Week 3 (Jan 15-21): Current week, count actual appointments
 * // Week 4 (Jan 22-28): Future week, count 0
 * // Week 5 (Jan 29-31): Future week, count 0
 *
 * calculateWeekBasedCompletedCalls(subscriptionStart, subscriptionEnd, currentDate, 2, appointments, "sub-123", 2)
 * // Returns 4 + actualCurrentWeekCalls (4 from past weeks + current week actuals)
 */
function calculateWeekBasedCompletedCalls(
  subscriptionStart: Date,
  subscriptionEnd: Date,
  currentDate: Date,
  callsPerWeek: number,
  existingAppointments: any[],
  subscriptionId: string,
  slotsPerCall: number
): number {
  // Helper function to get start of week (Sunday)
  const getWeekStart = (date: Date): Date => {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const day = d.getDay(); // 0 = Sunday
    d.setDate(d.getDate() - day);
    return d;
  };

  // Get week boundaries
  const subscriptionWeekStart = getWeekStart(subscriptionStart);

  // Count completed calls week by week
  let completedCalls = 0;
  let weekStart = new Date(subscriptionWeekStart);

  while (weekStart < subscriptionEnd) {
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    // Check if this week is completely in the past
    if (weekEnd < currentDate) {
      // Assume all calls for this past week were completed
      completedCalls += callsPerWeek;
    } else if (weekStart <= currentDate && currentDate <= weekEnd) {
      // Current week - count actual completed appointments
      const currentWeekCompleted = existingAppointments.filter((appt: any) => {
        if (appt.appointmentType !== "SUBSCRIPTION") return false;
        if (!appt.subscription || appt.subscription.id !== subscriptionId)
          return false;

        const slots = appt.slotsOfAppointment || [];
        if (slots.length !== slotsPerCall) return false;

        const firstSlot = slots[0];
        const appointmentDate = new Date(firstSlot.slotStartTimeInUTC);
        const isInThisWeek =
          appointmentDate >= weekStart && appointmentDate <= weekEnd;

        const lastSlot = slots[slots.length - 1];
        const lastEnd = new Date(
          lastSlot.slotEndTimeInUTC || lastSlot.slotStartTimeInUTC
        );
        const isCompleted = lastEnd < currentDate;

        return isInThisWeek && isCompleted;
      }).length;

      completedCalls += currentWeekCompleted;
    }
    // Future weeks: don't count anything

    // Move to next week
    weekStart.setDate(weekStart.getDate() + 7);
  }

  // Cap at total possible sessions
  const totalSubscriptionWeeks = countSundayWeeksInclusive(
    subscriptionStart,
    subscriptionEnd
  );
  const maxPossibleSessions = totalSubscriptionWeeks * callsPerWeek;
  return Math.min(completedCalls, maxPossibleSessions);
}

function computeSubscriptionFooter(
  params: Readonly<{
    selectedSlots: TimeSlot[];
    allowedStart?: Date;
    allowedEnd?: Date;
    callsPerWeek?: number;
    sessionDurationInHours?: number;
    existingAppointments?: any[];
    subscriptionId?: string;
  }>
): string | null {
  const {
    selectedSlots,
    allowedStart,
    allowedEnd,
    callsPerWeek,
    sessionDurationInHours,
    existingAppointments,
    subscriptionId,
  } = params;
  if (!allowedStart || !allowedEnd || !callsPerWeek) return null;

  const weeks = countSundayWeeksInclusive(allowedStart, allowedEnd);
  const maxTotalCalls = weeks * callsPerWeek;
  const slotsPerCall = getSlotsPerCall(sessionDurationInHours);
  const selectedCompleted = Math.floor(selectedSlots.length / slotsPerCall);

  // Week-based completion logic: past complete weeks assumed + current week actual
  const pastCompleted = calculateWeekBasedCompletedCalls(
    allowedStart,
    allowedEnd,
    new Date(),
    callsPerWeek,
    existingAppointments || [],
    subscriptionId || "",
    slotsPerCall
  );

  // Only count actual completed calls, not selected ones
  const totalCompleted = Math.min(maxTotalCalls, pastCompleted);

  return `Calls completed: ${totalCompleted}/${maxTotalCalls} (${pastCompleted} completed, ${selectedCompleted} calls selected to be scheduled)`;
}

/** Counts total completed class sessions across all selected slots. */
function countCompletedSelectedClasses(
  selectedSlots: TimeSlot[],
  slotsPerSession: number
): number {
  if (!selectedSlots?.length) return 0;
  // Group by day and count full consecutive runs
  const byDay = new Map<string, TimeSlot[]>();
  for (const s of selectedSlots) {
    const key = s.startTime.toDateString();
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(s);
  }
  let sessions = 0;
  byDay.forEach((daySlots) => {
    const sorted = [...daySlots].sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime()
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
 * Counts past completed class sessions using 30‑minute intervals (current allocations).
 * A completed session is a contiguous run of exactly `slotsPerSession` slots on the same day,
 * and the session's last slot must end before `now`.
 */
function countPastCompletedClassSessionsFromIntervals(
  intervals: TimeSlot[],
  slotsPerSession: number,
  now: Date
): number {
  if (!intervals?.length) return 0;

  // Consider only intervals that have fully ended in the past
  const pastIntervals = intervals.filter((s) => s.endTime < now);
  if (pastIntervals.length === 0) return 0;

  // Group by day
  const byDay = new Map<string, TimeSlot[]>();
  for (const s of pastIntervals) {
    const key = s.startTime.toDateString();
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(s);
  }

  let completed = 0;
  byDay.forEach((daySlots) => {
    const sorted = [...daySlots].sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime()
    );
    let run: TimeSlot[] = [];
    let lastEnd: number | null = null;
    const flush = () => {
      if (run.length === 0) return;
      let i = 0;
      while (i + slotsPerSession - 1 < run.length) {
        completed += 1;
        i += slotsPerSession;
      }
      run = [];
    };
    for (const slot of sorted) {
      if (lastEnd !== null && slot.startTime.getTime() !== lastEnd) {
        flush();
      }
      run.push(slot);
      lastEnd = slot.endTime.getTime();
    }
    flush();
  });

  return completed;
}

/** Footer text for classes: show classes completed vs required. */
function computeClassFooter(params: {
  selectedSlots: TimeSlot[];
  sessionDurationInHours?: number;
  totalSessions?: number;
  existingAppointments?: any[];
  classId?: string;
  currentIntervals?: TimeSlot[];
  allowedEnd?: Date;
}): string {
  const {
    selectedSlots,
    sessionDurationInHours,
    totalSessions,
    existingAppointments,
    classId,
    currentIntervals,
    allowedEnd,
  } = params;
  const slotsPerSession = Math.ceil((sessionDurationInHours || 1) / 0.5);

  // Count completed classes from intervals if available (preferred), else from existing appointments
  let pastCompleted = 0;
  if (Array.isArray(currentIntervals) && currentIntervals.length > 0) {
    pastCompleted = countPastCompletedClassSessionsFromIntervals(
      currentIntervals,
      slotsPerSession,
      new Date()
    );
  } else if (classId && existingAppointments) {
    pastCompleted = countCompletedClassesForClass(
      existingAppointments,
      classId,
      slotsPerSession
    );
  }

  // Count completed classes from current selection
  const selectedCompleted = countCompletedSelectedClasses(
    selectedSlots,
    slotsPerSession
  );

  // If the class window has ended, treat all sessions as completed
  if (allowedEnd && new Date() > allowedEnd) {
    const total =
      typeof totalSessions === "number" && totalSessions > 0
        ? totalSessions
        : pastCompleted;
    if (typeof totalSessions === "number" && totalSessions > 0) {
      return `Classes completed: ${total}/${totalSessions} (${total} completed, 0 classes selected to be scheduled)`;
    }
    return `Classes completed: ${total} (${total} completed, 0 classes selected to be scheduled)`;
  }

  // Only count actual completed classes, not selected ones
  const totalCompleted = pastCompleted;

  if (typeof totalSessions === "number" && totalSessions > 0) {
    return `Classes completed: ${totalCompleted}/${totalSessions} (${pastCompleted} completed, ${selectedCompleted} classes selected to be scheduled)`;
  }
  return `Classes completed: ${totalCompleted} (${pastCompleted} completed, ${selectedCompleted} classes selected to be scheduled)`;
}

/**
 * Props for the UnifiedCalendar component.
 *
 * This component provides a unified interface for managing different types of calendar events:
 * - Consultations: One-time meetings with specific duration
 * - Subscriptions: Recurring weekly calls over a period
 * - Webinars: One-time events with specific duration
 * - Classes: Recurring sessions over a period
 *
 * @example
 * // Consultation example
 * <UnifiedCalendar
 *   consultantId="consultant-123"
 *   eventType="consultation"
 *   durationInHours={1.5}
 *   mode="allocate"
 *   onAllocationComplete={(result) => console.log('Allocated:', result)}
 * />
 *
 * // Subscription example
 * <UnifiedCalendar
 *   consultantId="consultant-123"
 *   eventType="subscription"
 *   eventId="sub-456"
 *   durationInMonths={3}
 *   callsPerWeek={2}
 *   sessionDurationInHours={1}
 *   mode="allocate"
 *   allowedStart={new Date('2024-01-01')}
 *   allowedEnd={new Date('2024-03-31')}
 *   showSubscriptionSidebar={true}
 * />
 */
export interface UnifiedCalendarProps {
  /** Unique identifier for the consultant whose calendar to display */
  consultantId: string;

  /** Type of event being managed */
  eventType: "consultation" | "subscription" | "webinar" | "class";

  /** Optional ID of the specific event (required for subscriptions/classes) */
  eventId?: string;

  /** Duration in months (for subscriptions/classes) */
  durationInMonths?: number;

  /** Duration in hours (for consultations/webinars) */
  durationInHours?: number;

  /** Number of calls per week (for subscriptions) */
  callsPerWeek?: number;

  /** Individual session duration in hours (for subscriptions/classes) */
  sessionDurationInHours?: number;

  /** Interaction mode: view-only, manual selection, or auto-allocation */
  mode: "view" | "select" | "allocate";

  /** Callback when user selects slots (in select mode) */
  onSlotsSelected?: (slots: TimeSlot[]) => void;

  /** Callback when allocation is completed */
  onAllocationComplete?: (result: any) => void;

  /** Whether to show allocation action buttons */
  showAllocationButtons?: boolean;

  /** Pre-selected slots to initialize with */
  preSelectedSlots?: TimeSlot[];

  /** Requested slots from user preferences */
  requestedSlots?: TimeSlot[];

  /**
   * Explicitly provided allocated slots for the event. Use this to show
   * "Previous allocation" across all weeks for one-day events (consultations/webinars).
   *
   * @example
   * // Show existing consultation slots
   * currentSlots={[
   *   { startTime: new Date('2024-01-15T10:00:00Z'), endTime: new Date('2024-01-15T11:00:00Z') }
   * ]}
   */
  currentSlots?: TimeSlot[];

  /** Additional CSS classes */
  className?: string;

  /** Optional hard boundaries to restrict interactive selection */
  allowedStart?: Date;
  allowedEnd?: Date;

  /** Optional Cancel action to render inline in the footer controls */
  onCancel?: () => void;

  /** Whether to show subscription-specific sidebar with week info */
  showSubscriptionSidebar?: boolean;

  /** Whether to highlight current slots even in view mode */
  highlightCurrentSlotsInView?: boolean;

  /** When enabled, auto-focus week to first event slot/current slot */
  autoFocusOnEventSlots?: boolean;
}

/**
 * UnifiedCalendar - A comprehensive calendar component for managing different event types.
 *
 * This component provides a unified interface for:
 * - Viewing consultant availability
 * - Selecting time slots for events
 * - Auto-allocating slots based on preferences
 * - Managing subscriptions, consultations, webinars, and classes
 *
 * Key Features:
 * - Week and month view modes
 * - Real-time availability checking
 * - Conflict detection and prevention
 * - Auto-allocation with smart algorithms
 * - Rescheduling support for recurring events
 * - Timezone-aware display
 *
 * @param props - Configuration object for the calendar
 *
 * @example
 * // Basic consultation booking
 * <UnifiedCalendar
 *   consultantId="consultant-123"
 *   eventType="consultation"
 *   durationInHours={1}
 *   mode="allocate"
 *   showAllocationButtons={true}
 *   onAllocationComplete={(result) => {
 *     if (result.success) {
 *       console.log('Slots allocated:', result.selectedSlots);
 *     }
 *   }}
 * />
 *
 * // Subscription management with rescheduling
 * <UnifiedCalendar
 *   consultantId="consultant-123"
 *   eventType="subscription"
 *   eventId="sub-456"
 *   durationInMonths={3}
 *   callsPerWeek={2}
 *   sessionDurationInHours={1}
 *   mode="allocate"
 *   allowedStart={new Date('2024-01-01')}
 *   allowedEnd={new Date('2024-03-31')}
 *   showSubscriptionSidebar={true}
 *   highlightCurrentSlotsInView={true}
 *   currentSlots={existingSubscriptionSlots}
 * />
 */
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
  showAllocationButtons = false,
  preSelectedSlots = [],
  requestedSlots = [],
  currentSlots = [],
  className = "",
  allowedStart,
  allowedEnd,
  onCancel,
  showSubscriptionSidebar = false,
  highlightCurrentSlotsInView = false,
  autoFocusOnEventSlots = false,
}: Readonly<UnifiedCalendarProps>) {
  const { toast } = useToast();

  // ===== COMPONENT STATE =====

  /** Current date being displayed in the calendar */
  const [currentDate, setCurrentDate] = useState(() => new Date());

  /** Calendar view mode: week or month */
  const [view, setView] = useState<"week" | "month">("week");

  /** User's browser timezone for display purposes */
  const [browserTimezone, setBrowserTimezone] = useState("UTC");

  /** Whether to show the allocation confirmation dialog */
  const [showConfirmationDialog, setShowConfirmationDialog] = useState(false);

  /** ID of previously selected call for rescheduling (subscriptions/classes) */
  const [selectedPrevCallId, setSelectedPrevCallId] = useState<string | null>(
    null
  );

  // ===== EFFECTS =====

  /** Initialize browser timezone on component mount */
  useEffect(() => {
    setBrowserTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);

  // ===== DATA HOOKS =====

  /**
   * Calendar data hook that provides:
   * - Consultant availability information
   * - Existing appointments and conflicts
   * - Event-specific slot data
   * - Real-time slot status checking
   */
  const {
    consultantDetails,
    availableSlots,
    existingAppointments,
    eventSlots,
    loading,
    error,
    refetch,
    getSlotStatusForInterval,
  } = useCalendarData({
    consultantId,
    eventType,
    eventId,
    currentDate,
    view,
  });

  // ===== EVENT HANDLERS =====

  /**
   * Handles successful allocation completion.
   *
   * This callback:
   * 1. Logs the allocation result for debugging
   * 2. Refreshes calendar data to show updated availability
   * 3. Calls the parent component's completion handler
   *
   * @param result - The allocation result from the server
   */
  const handleAllocationComplete = useCallback(
    async (result: any) => {
      console.log("[UnifiedCalendar] Allocation completed", {
        eventType,
        eventId,
        consultantId,
        result,
      });
      await refetch();
      onAllocationComplete?.(result);
    },
    [eventType, eventId, consultantId, refetch, onAllocationComplete]
  );

  // ===== COMPUTED VALUES =====

  /**
   * Build list and set of current event intervals (previous allocations).
   *
   * This memoized value processes different sources of current slots:
   * 1. Explicitly provided currentSlots prop (highest priority)
   * 2. Server-fetched eventSlots (for webinars/classes)
   * 3. Existing appointments filtered by event type
   *
   * The function also handles slot expansion to 30-minute intervals
   * for consistent display across different event types.
   *
   * @returns Array of TimeSlot objects representing current allocations
   *
   * @example
   * // For a 1-hour consultation with currentSlots prop:
   * currentSlots = [
   *   { startTime: '2024-01-15T10:00:00Z', endTime: '2024-01-15T11:00:00Z' }
   * ]
   * // Returns: [
   *   { startTime: '2024-01-15T10:00:00Z', endTime: '2024-01-15T10:30:00Z', isBooked: true },
   *   { startTime: '2024-01-15T10:30:00Z', endTime: '2024-01-15T11:00:00Z', isBooked: true }
   * ]
   */
  const currentEventIntervals = useMemo((): TimeSlot[] => {
    try {
      // Debug log for currentSlots (only if slots exist)
      if (currentSlots && currentSlots.length > 0) {
        console.log("[UnifiedCalendar] Current slots found:", {
          eventType,
          eventId,
          currentSlotsCount: currentSlots.length,
        });
      }

      /**
       * Utility function to round time to nearest 30 minutes.
       *
       * This ensures all time slots align with the 30-minute grid
       * used throughout the calendar system.
       *
       * @param date - Date to round
       * @param intervalMinutes - Interval to round to (default: 30)
       * @returns Rounded date
       *
       * @example
       * roundToNearestInterval(new Date('2024-01-15T10:17:30Z'))
       * // Returns: new Date('2024-01-15T10:30:00Z')
       *
       * roundToNearestInterval(new Date('2024-01-15T10:47:30Z'))
       * // Returns: new Date('2024-01-15T11:00:00Z')
       */
      const roundToNearestInterval = (
        date: Date,
        intervalMinutes: number = 30
      ): Date => {
        const rounded = new Date(date);
        const minutes = rounded.getMinutes();
        const roundedMinutes =
          Math.round(minutes / intervalMinutes) * intervalMinutes;

        if (roundedMinutes >= 60) {
          rounded.setHours(rounded.getHours() + 1);
          rounded.setMinutes(0);
        } else {
          rounded.setMinutes(roundedMinutes);
        }

        // Reset seconds and milliseconds
        rounded.setSeconds(0);
        rounded.setMilliseconds(0);

        return rounded;
      };

      /**
       * Helper: expand any slot range into 30-minute intervals so the full session highlights.
       *
       * This function takes a slot with any duration and breaks it down into
       * 30-minute intervals for consistent display in the calendar grid.
       *
       * @param slots - Array of TimeSlot objects to expand
       * @returns Array of 30-minute TimeSlot intervals
       *
       * @example
       * const slots = [
       *   { startTime: '2024-01-15T10:00:00Z', endTime: '2024-01-15T11:30:00Z' }
       * ];
       *
       * expandToHalfHourIntervals(slots)
       * // Returns: [
       *   { startTime: '10:00:00Z', endTime: '10:30:00Z', isBooked: true },
       *   { startTime: '10:30:00Z', endTime: '11:00:00Z', isBooked: true },
       *   { startTime: '11:00:00Z', endTime: '11:30:00Z', isBooked: true }
       * ]
       */
      const expandToHalfHourIntervals = (slots: TimeSlot[]): TimeSlot[] => {
        const intervals: TimeSlot[] = [];
        for (const s of slots) {
          const roundedStart = roundToNearestInterval(s.startTime, 30);
          const roundedEnd = roundToNearestInterval(s.endTime, 30);
          const durationMinutes = Math.max(
            0,
            Math.round(
              (roundedEnd.getTime() - roundedStart.getTime()) / (1000 * 60)
            )
          );
          const numIntervals = Math.max(1, Math.round(durationMinutes / 30));
          for (let i = 0; i < numIntervals; i++) {
            const intervalStart = new Date(
              roundedStart.getTime() + i * 30 * 60 * 1000
            );
            const intervalEnd = new Date(
              intervalStart.getTime() + 30 * 60 * 1000
            );
            intervals.push({
              startTime: intervalStart,
              endTime: intervalEnd,
              isAvailable: true,
              isBooked: true,
            });
          }
        }
        return intervals;
      };

      // Priority: Prop provided currentSlots (e.g., from appointment data)
      if (Array.isArray(currentSlots) && currentSlots.length > 0) {
        return expandToHalfHourIntervals(currentSlots);
      }

      // Then fallback to server-fetched event slots (webinar/class)
      if (Array.isArray(eventSlots) && eventSlots.length > 0) {
        if (eventType === "class") {
          // Ensure both 30‑min blocks of a 1‑hour session appear as Current Slots
          const slotsPerSession = Math.ceil(
            (sessionDurationInHours || 1) / 0.5
          );
          const seen = new Set<string>();
          const intervals: TimeSlot[] = [];
          // Treat every unique start as a session start and expand by duration
          for (const s of eventSlots as TimeSlot[]) {
            const startIso = new Date(s.startTime).toISOString();
            if (seen.has(startIso)) continue;
            seen.add(startIso);
            for (let i = 0; i < slotsPerSession; i++) {
              const intervalStart = new Date(
                new Date(s.startTime).getTime() + i * 30 * 60 * 1000
              );
              const intervalEnd = new Date(
                intervalStart.getTime() + 30 * 60 * 1000
              );
              intervals.push({
                startTime: intervalStart,
                endTime: intervalEnd,
                isAvailable: true,
                isBooked: true,
              });
            }
          }
          return intervals;
        }
        return expandToHalfHourIntervals(eventSlots as TimeSlot[]);
      }

      if (!eventType || !eventId) return [];
      const intervals: TimeSlot[] = [];
      const matchesEvent = (appt: any): boolean => {
        if (!appt) return false;
        switch (eventType) {
          case "consultation":
            return (
              appt.appointmentType === "CONSULTATION" &&
              appt.consultation &&
              appt.consultation.id === eventId
            );
          case "subscription":
            return (
              appt.appointmentType === "SUBSCRIPTION" &&
              appt.subscription &&
              appt.subscription.id === eventId
            );
          case "webinar":
            return (
              appt.appointmentType === "WEBINAR" &&
              appt.webinar &&
              appt.webinar.id === eventId
            );
          case "class":
            return (
              appt.appointmentType === "CLASS" &&
              appt.class &&
              appt.class.id === eventId
            );
          default:
            return false;
        }
      };
      const relevant = (existingAppointments || []).filter(matchesEvent);
      // roundToNearestInterval already defined above

      // (duplicate removed)

      for (const appt of relevant) {
        const slots = appt.slotsOfAppointment || [];
        for (const s of slots) {
          const start = new Date(s.slotStartTimeInUTC);
          const end = new Date(s.slotEndTimeInUTC);

          // Round start and end times to nearest 30 minutes
          const roundedStart = roundToNearestInterval(start, 30);
          const roundedEnd = roundToNearestInterval(end, 30);

          const durationMinutes = Math.round(
            (roundedEnd.getTime() - roundedStart.getTime()) / (1000 * 60)
          );
          const numIntervals = Math.max(1, Math.round(durationMinutes / 30));
          for (let i = 0; i < numIntervals; i++) {
            const intervalStart = new Date(
              roundedStart.getTime() + i * 30 * 60 * 1000
            );
            const intervalEnd = new Date(
              intervalStart.getTime() + 30 * 60 * 1000
            );
            intervals.push({
              startTime: intervalStart,
              endTime: intervalEnd,
              isAvailable: true,
              isBooked: true,
            });
          }
        }
      }
      return intervals;
    } catch {
      return [];
    }
  }, [eventSlots, eventType, eventId, existingAppointments]);

  const currentEventIsoSet = useMemo(() => {
    try {
      // Base: all intervals explicitly provided
      const baseStarts = currentEventIntervals.map((s) => s.startTime);

      // For classes, ensure we expand from session starts to the full duration,
      // in case upstream provided only the first block.
      if (eventType === "class") {
        const slotsPerSession = Math.ceil((sessionDurationInHours || 1) / 0.5);
        const byIso = new Set<string>();

        // Derive session starts: sort and pick timestamps that are not 30 min after a previous one
        const sorted = [...baseStarts].sort(
          (a, b) => a.getTime() - b.getTime()
        );
        const sessionStarts: Date[] = [];
        for (let i = 0; i < sorted.length; i++) {
          const prev = i > 0 ? sorted[i - 1] : null;
          const cur = sorted[i];
          if (!prev || cur.getTime() !== prev.getTime() + 30 * 60 * 1000) {
            sessionStarts.push(cur);
          }
        }

        // Expand each session start across its 30‑min blocks
        for (const start of sessionStarts) {
          for (let i = 0; i < slotsPerSession; i++) {
            const ts = new Date(
              start.getTime() + i * 30 * 60 * 1000
            ).toISOString();
            byIso.add(ts);
          }
        }

        if (byIso.size > 0) return byIso;
      }

      return new Set(baseStarts.map((d) => d.toISOString()));
    } catch {
      return new Set<string>();
    }
  }, [currentEventIntervals, eventType, sessionDurationInHours]);

  // Slot allocation hook
  const {
    selectedSlots,
    setSelectedSlots,
    isAllocating,
    allocationError,
    toggleSlot,
    clearSlots,
    isSlotSelected,
    manualAllocate,
    manualAllocateWithReschedule,
    autoAllocate,
    preAllocate,
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
    // Provide dynamic maxTotalCalls so validation/toasts show the real limit
    maxTotalCalls:
      eventType === "subscription" && allowedStart && allowedEnd && callsPerWeek
        ? countSundayWeeksInclusive(allowedStart, allowedEnd) *
          (callsPerWeek || 1)
        : undefined,
    onSuccess: handleAllocationComplete,
  });

  // Initialize pre-selected slots
  useEffect(() => {
    if (preSelectedSlots.length > 0) {
      setSelectedSlots(preSelectedSlots);
    }
  }, [preSelectedSlots, setSelectedSlots]);

  // Call onSlotsSelected when selection changes
  useEffect(() => {
    if (mode !== "select" || !onSlotsSelected) return;
    // Avoid redundant updates by comparing by identity length + first/last timestamps
    try {
      onSlotsSelected(selectedSlots);
    } catch (error) {
      console.error("Error calling onSlotsSelected:", error);
    }
  }, [selectedSlots, mode, onSlotsSelected]);

  // Week view dates
  const weekDates = useMemo(() => {
    const startDate = startOfWeek(currentDate);
    return [...Array(7)].map((_, i) => addDays(startDate, i));
  }, [currentDate]);

  // Collect the visible week's available 30-min intervals as TimeSlot[]
  const collectWeekAvailableSlots = useCallback((): TimeSlot[] => {
    const slots: TimeSlot[] = [];
    for (const date of weekDates) {
      for (const interval of INTERVALS) {
        const status = getSlotStatusForInterval(interval, date);
        if (status.isAvailable && !status.isInPast) {
          slots.push({
            startTime: new Date(status.intervalStartUTCString),
            endTime: new Date(status.intervalEndUTCString),
            isAvailable: status.isAvailable,
            isBooked: status.isBooked,
          });
        }
      }
    }
    return slots;
  }, [weekDates, getSlotStatusForInterval]);

  // Previous allocations in the visible week (subscriptions only)

  // Note: Appointments are fetched via useCalendarData hook and passed to convertExistingAppointmentsToCalls

  // ===== RESCHEDULING HELPERS =====

  /**
   * Converts existing appointments into calls for rescheduling.
   *
   * This function processes appointment data to create a list of reschedulable calls:
   * 1. Filters appointments by event type and ID
   * 2. Groups consecutive slots by day to form complete calls
   * 3. Creates call objects with unique IDs for rescheduling
   * 4. Filters to only include calls in the current week
   *
   * @param appointments - Array of existing appointments
   * @param eventId - ID of the event to filter by
   * @param eventType - Type of event (subscription/class)
   * @returns Array of call objects for rescheduling
   *
   * @example
   * const appointments = [
   *   {
   *     id: "appt-123",
   *     appointmentType: "SUBSCRIPTION",
   *     subscription: { id: "sub-456" },
   *     slotsOfAppointment: [
   *       { slotStartTimeInUTC: "2024-01-15T10:00:00Z", slotEndTimeInUTC: "2024-01-15T10:30:00Z" },
   *       { slotStartTimeInUTC: "2024-01-15T10:30:00Z", slotEndTimeInUTC: "2024-01-15T11:00:00Z" }
   *     ]
   *   }
   * ];
   *
   * convertExistingAppointmentsToCalls(appointments, "sub-456", "subscription")
   * // Returns: [
   *   { id: "appt-123::2024-01-15T10:00:00.000Z", start: Date, end: Date }
   * ]
   */
  const convertExistingAppointmentsToCalls = useCallback(
    (appointments: any[], eventId: string, eventType: string) => {
      if (!appointments.length) return [];

      const calls: Array<{ id: string; start: Date; end: Date }> = [];

      // Get current week boundaries
      const weekStart = startOfWeek(currentDate);
      const weekEnd = endOfWeek(currentDate);

      // Filter appointments for this specific event (subscription or class)
      const eventAppointments = appointments.filter((appt) => {
        if (eventType === "subscription") {
          return (
            appt.appointmentType === "SUBSCRIPTION" &&
            appt.subscription &&
            appt.subscription.id === eventId
          );
        } else if (eventType === "class") {
          return (
            appt.appointmentType === "CLASS" &&
            appt.class &&
            appt.class.id === eventId
          );
        }
        return false;
      });

      // Process each appointment
      for (const appt of eventAppointments) {
        const slots = appt.slotsOfAppointment || [];
        if (slots.length === 0) continue;

        // Sort slots by start time
        const sortedSlots = slots.sort(
          (a: any, b: any) =>
            new Date(a.slotStartTimeInUTC).getTime() -
            new Date(b.slotStartTimeInUTC).getTime()
        );

        // Group slots by day
        const slotsByDay = new Map<string, any[]>();
        for (const slot of sortedSlots) {
          const dayKey = new Date(slot.slotStartTimeInUTC).toDateString();
          if (!slotsByDay.has(dayKey)) {
            slotsByDay.set(dayKey, []);
          }
          slotsByDay.get(dayKey)!.push(slot);
        }

        // Process each day
        for (const [dayKey, daySlots] of Array.from(slotsByDay.entries())) {
          if (daySlots.length === 0) continue;

          // Find continuous slots and create calls
          let currentCallSlots: any[] = [];

          for (let i = 0; i < daySlots.length; i++) {
            const currentSlot = daySlots[i];

            if (currentCallSlots.length === 0) {
              // Start a new call
              currentCallSlots = [currentSlot];
            } else {
              // Check if this slot is continuous with the previous one
              const lastSlot = currentCallSlots[currentCallSlots.length - 1];
              const lastEnd = new Date(
                lastSlot.slotEndTimeInUTC || lastSlot.slotStartTimeInUTC
              );
              const currentStart = new Date(currentSlot.slotStartTimeInUTC);

              if (currentStart.getTime() === lastEnd.getTime()) {
                // Continuous slot, add to current call
                currentCallSlots.push(currentSlot);
              } else {
                // Break in continuity, finish current call and start new one
                if (currentCallSlots.length > 0) {
                  const callStart = new Date(
                    currentCallSlots[0].slotStartTimeInUTC
                  );
                  const callEnd = new Date(
                    currentCallSlots[currentCallSlots.length - 1]
                      .slotEndTimeInUTC ||
                      currentCallSlots[currentCallSlots.length - 1]
                        .slotStartTimeInUTC
                  );
                  calls.push({
                    id: `${appt.id}::${callStart.toISOString()}`, // Unique ID for each call
                    start: callStart,
                    end: callEnd,
                  });
                }
                currentCallSlots = [currentSlot];
              }
            }
          }

          // Don't forget the last call of the day
          if (currentCallSlots.length > 0) {
            const callStart = new Date(currentCallSlots[0].slotStartTimeInUTC);
            const callEnd = new Date(
              currentCallSlots[currentCallSlots.length - 1].slotEndTimeInUTC ||
                currentCallSlots[currentCallSlots.length - 1].slotStartTimeInUTC
            );
            calls.push({
              id: `${appt.id}::${callStart.toISOString()}`, // Unique ID for each call
              start: callStart,
              end: callEnd,
            });
          }
        }
      }

      // Filter calls to only include those in the current week
      const callsInCurrentWeek = calls.filter((call) => {
        return call.start >= weekStart && call.start <= weekEnd;
      });

      return callsInCurrentWeek.sort(
        (a, b) => a.start.getTime() - b.start.getTime()
      );
    },
    [currentDate]
  );

  const _callsThisWeek = useMemo(() => {
    if (eventType !== "subscription" || !eventId || !sessionDurationInHours)
      return 0;
    const weekStart = startOfWeek(currentDate);
    const weekEnd = endOfWeek(currentDate);
    const slotsPerCall = getSlotsPerCall(sessionDurationInHours);
    return countCompletedCallsForWeek(
      existingAppointments,
      eventId,
      slotsPerCall,
      weekStart,
      weekEnd
    );
  }, [
    existingAppointments,
    eventType,
    eventId,
    currentDate,
    sessionDurationInHours,
  ]);

  const reschedulingActive = !!selectedPrevCallId;

  // Current week calls for subscription (for sidebar display)
  const currentWeekCalls = useMemo(() => {
    try {
      if ((eventType !== "subscription" && eventType !== "class") || !eventId)
        return [] as Array<{ id: string; start: Date; end: Date }>;
      return convertExistingAppointmentsToCalls(
        existingAppointments,
        eventId,
        eventType
      );
    } catch {
      return [] as Array<{ id: string; start: Date; end: Date }>;
    }
  }, [
    eventType,
    eventId,
    existingAppointments,
    convertExistingAppointmentsToCalls,
  ]);

  // ===== AUTO-FOCUS LOGIC =====

  /**
   * Auto-focus to first event/current slot in view (opt-in, no side effects by default).
   *
   * This effect automatically navigates the calendar to show the first relevant slot:
   * 1. Checks if auto-focus is enabled
   * 2. Looks for event slots first, then current slots
   * 3. Sets the calendar date to show that slot
   * 4. Prevents repeated auto-focusing with ref guard
   *
   * @example
   * // User opens calendar with existing subscription slots
   * // Calendar automatically navigates to the week containing the first slot
   * // User sees their existing appointments without manual navigation
   */
  const hasAutoFocusedRef = useRef(false);
  useEffect(() => {
    if (!autoFocusOnEventSlots || hasAutoFocusedRef.current) return;

    let targetDate: Date | null = null;
    if (Array.isArray(eventSlots) && eventSlots.length > 0) {
      targetDate = eventSlots[0]?.startTime || null;
    } else if (Array.isArray(currentSlots) && currentSlots.length > 0) {
      targetDate = currentSlots[0]?.startTime || null;
    }

    if (targetDate) {
      setCurrentDate(new Date(targetDate));
      hasAutoFocusedRef.current = true;
    }
  }, [autoFocusOnEventSlots, eventSlots, currentSlots]);

  // ===== SLOT INTERACTION HANDLERS =====

  /**
   * Handles slot click events for manual selection.
   *
   * This function implements a comprehensive validation pipeline:
   * 1. Mode validation (only allow in select/allocate modes)
   * 2. Allowed range validation (respects subscription/class boundaries)
   * 3. Weekly limit validation (prevents overbooking subscriptions)
   * 4. Availability validation (ensures slot is actually available)
   * 5. Past time validation (prevents selecting past slots)
   *
   * @param interval - Time interval clicked (hour, minute)
   * @param date - Date of the clicked slot
   *
   * @example
   * // User clicks 10:00 AM slot on January 15th
   * handleSlotClick({ hour: 10, minute: 0 }, new Date('2024-01-15'))
   *
   * // Validation flow:
   * // 1. Check if mode allows selection
   * // 2. Check if slot is within allowedStart/allowedEnd
   * // 3. Check if weekly call limit not exceeded
   * // 4. Check if slot is available and not in past
   * // 5. Add/remove slot from selection
   */
  const handleSlotClick = useCallback(
    (interval: { hour: number; minute: number }, date: Date) => {
      if (mode === "view") return;

      const status = getSlotStatusForInterval(interval, date);

      // First-line guard: allow click but block selection with feedback if outside allowed range
      if (allowedStart || allowedEnd) {
        const intervalStart = new Date(status.intervalStartUTCString);
        if (isOutsideAllowedRange(intervalStart, allowedStart, allowedEnd)) {
          const label =
            eventType === "subscription"
              ? "subscription"
              : eventType === "class"
                ? "class"
                : "event";
          toast({
            variant: "destructive",
            title: "Slot outside allowed period",
            description: `This ${label} allows scheduling only between ${formatAllowedRange(allowedStart, allowedEnd)}.`,
          });
          return;
        }
      }
      /**
       * Weekly limit guard for subscriptions: fire on FIRST slot of a new day.
       *
       * This prevents users from overbooking a week by:
       * 1. Detecting when user starts selecting a new day
       * 2. Counting existing completed calls in that week
       * 3. Counting already selected calls in that week
       * 4. Blocking selection if weekly limit would be exceeded
       *
       * @example
       * // User has 2 calls per week limit
       * // Week already has 1 completed call + 1 selected call = 2 total
       * // User tries to start a 3rd call on a new day
       * // System blocks with "Weekly Call Limit Reached" toast
       */
      if (
        eventType === "subscription" &&
        eventId &&
        callsPerWeek &&
        sessionDurationInHours
      ) {
        const intervalStart = new Date(status.intervalStartUTCString);
        const isStartingNewDay = !selectedSlots.some(
          (s) => s.startTime.toDateString() === intervalStart.toDateString()
        );

        if (isStartingNewDay) {
          const weekStart = startOfWeek(intervalStart);
          const weekEnd = endOfWeek(intervalStart);
          const slotsPerCall = getSlotsPerCall(sessionDurationInHours);
          const completedCalls = countCompletedCallsForWeek(
            existingAppointments,
            eventId,
            slotsPerCall,
            weekStart,
            weekEnd
          );

          // Also include already selected complete calls in this same week
          const selectedCompleted = countCompletedSelectedCallsForWeek(
            selectedSlots,
            slotsPerCall,
            weekStart,
            weekEnd
          );
          const totalCompletedThisWeek = completedCalls + selectedCompleted;

          if (
            !reschedulingActive &&
            totalCompletedThisWeek >= (callsPerWeek || 1)
          ) {
            toast({
              variant: "destructive",
              title: "Weekly Call Limit Reached",
              description: `Week of ${weekStart.toLocaleDateString()} already has ${totalCompletedThisWeek}/${callsPerWeek} completed call(s). Start a call in another week.`,
            });
            return;
          }
        }
      }

      // Allow selection even if booked or not available; server will validate conflicts
      // Still block past intervals for UX sanity
      if (status.isInPast) return;

      // Availability guard: only allow selecting slots that are in active availability
      if (!status.isAvailable) {
        toast({
          variant: "destructive",
          title: "Slot not available",
          description:
            "This time is not within active availability or is already booked.",
        });
        return;
      }

      const slot: TimeSlot = {
        startTime: new Date(status.intervalStartUTCString),
        endTime: new Date(status.intervalEndUTCString),
        isAvailable: status.isAvailable,
        isBooked: status.isBooked,
      };

      if (mode === "select" || mode === "allocate") {
        toggleSlot(slot);
      }
    },
    [
      mode,
      getSlotStatusForInterval,
      toggleSlot,
      // Dependencies used inside the callback
      eventType,
      eventId,
      callsPerWeek,
      sessionDurationInHours,
      allowedStart,
      allowedEnd,
      selectedSlots,
      existingAppointments,
      toast,
    ]
  );

  // ===== RENDERING FUNCTIONS =====

  /**
   * Renders a single time cell in the calendar grid.
   *
   * This function determines the visual state and behavior of each 30-minute slot:
   * - Available slots: Green background, clickable
   * - Selected slots: Blue background, clickable to deselect
   * - Booked slots: Gray background, not clickable
   * - Current allocated slots: Dark background, not clickable
   * - Past slots: Muted appearance, not clickable
   *
   * @param interval - Time interval (hour, minute)
   * @param date - Date of the slot
   * @returns JSX element for the time cell
   *
   * @example
   * // Render 10:00 AM slot on January 15th
   * renderTimeCell({ hour: 10, minute: 0 }, new Date('2024-01-15'))
   *
   * // Possible visual states:
   * // - Green button with "Available" text (clickable)
   * // - Blue button with "Selected" text (clickable)
   * // - Gray button with "Booked" text (not clickable)
   * // - Dark button with "Current Slots" text (not clickable)
   */
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
      const isCurrentAllocated = currentEventIsoSet.has(
        slot.startTime.toISOString()
      );

      // Log when we actually find a matching current slot
      if (eventType === "class" && isCurrentAllocated) {
        console.log("[UnifiedCalendar] Found class current slot:", {
          slotStart: slot.startTime.toISOString(),
        });
      }

      // Fast-exit: avoid rendering a clickable button for cells that have no
      // availability **and** are disabled (e.g. past date).  Rendering a
      // lightweight placeholder saves performance.
      if (!status.isAvailable && !status.isBooked && status.isInPast) {
        return (
          <div className="h-7 w-full bg-gray-100 border border-gray-200 rounded-sm" />
        );
      }

      let cellClassName =
        "h-7 w-full relative transition-colors duration-150 ease-in-out border border-transparent rounded-sm text-[10px] leading-tight px-0.5 py-0";
      let buttonText = "";
      const showTooltip =
        (status.isBookedForDisplay || status.isPartiallyBooked) &&
        status.overlappingAppointments.length > 0;

      if (
        isCurrentAllocated &&
        (mode !== "view" || highlightCurrentSlotsInView)
      ) {
        cellClassName += " bg-gray-700 text-gray-100 cursor-not-allowed";
        cellClassName += status.isInPast ? " opacity-70" : "";
        buttonText = "Current Slots";
      } else if (isCurrentlySelected) {
        cellClassName +=
          " bg-primary text-primary-foreground hover:bg-primary/90 border-primary-darker";
        buttonText = "Selected";
      } else if (status.isBookedForDisplay) {
        cellClassName += " bg-slate-400 text-slate-800 cursor-not-allowed";
        cellClassName += status.isInPast ? " opacity-50" : "";
        buttonText = "Booked";
      } else if (status.isPartiallyBooked) {
        cellClassName += " bg-yellow-400 text-yellow-900 cursor-not-allowed";
        cellClassName += status.isInPast ? " opacity-50" : "";
        buttonText = "Partially Booked";
      } else if (status.isAvailable) {
        if (status.isInPast) {
          cellClassName +=
            " bg-green-300 text-green-950 opacity-50 cursor-not-allowed border-green-400";
          buttonText = "Available";
        } else {
          // Add special hover effect for consultations to show the selected duration
          const hoverClass =
            eventType === "consultation"
              ? " hover:bg-green-400 hover:shadow-md"
              : " hover:bg-green-400";
          cellClassName += ` bg-green-300 text-green-950${hoverClass} border-green-400`;
          buttonText = "Available";
        }
      } else {
        if (status.isInPast) {
          cellClassName +=
            " bg-gray-300 text-gray-700 cursor-not-allowed opacity-70";
        } else {
          cellClassName += " bg-slate-200 cursor-not-allowed";
        }
      }

      const isButtonDisabled =
        (isCurrentAllocated && mode !== "view") ||
        (status.isInPast && !isCurrentlySelected && mode !== "view");

      const buttonElement = (
        <Button
          variant="ghost"
          className={cellClassName}
          onClick={() => handleSlotClick(interval, date)}
          disabled={isButtonDisabled}
        >
          {buttonText}
        </Button>
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
                  {status.overlappingAppointments.map(
                    (appSlot: AppointmentDetail, index: number) => (
                      <div
                        key={`${appSlot.id}-${index}`}
                        className="border-b border-border last:border-b-0 pb-1 mb-1 last:pb-0 last:mb-0"
                      >
                        <p className="font-semibold">{appSlot.title}</p>
                        <p className="text-muted-foreground">{appSlot.type}</p>
                        {appSlot.with && (
                          <p className="text-muted-foreground">
                            with {appSlot.with}
                          </p>
                        )}
                      </div>
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
      currentEventIsoSet,
      availableSlots,
      consultantDetails,
      loading,
      error,
      mode,
    ]
  );

  /**
   * Renders the month view of the calendar.
   *
   * This function creates a grid layout showing all days in the current month:
   * - Each day shows the number of available slots
   * - Past days are grayed out
   * - Current day is highlighted with a ring
   * - Days with no availability show "No Slots"
   *
   * @returns JSX element for the month view
   *
   * @example
   * // January 2024 month view
   * // Shows 31 days in a 7-column grid
   * // Each day shows available slot count or "No Slots"
   * // January 1st (Monday) starts in column 1
   * // January 15th (current day) has blue ring highlight
   */
  const renderMonthView = useCallback(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDayOfMonth = new Date(year, month, 1).getDay();
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    /**
     * Counts available slots for a specific day.
     *
     * @param date - Date to count slots for
     * @returns Number of available slots (excluding past slots)
     */
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
      <div className="grid grid-cols-7 gap-1 h-[600px] overflow-y-auto">
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
          }
        )}
      </div>
    );
  }, [currentDate, getSlotStatusForInterval]);

  // ===== RENDER STATES =====

  /** Loading state - shows spinner while calendar data is being fetched */
  if (loading) {
    return (
      <div className={`flex items-center justify-center p-8 ${className}`}>
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
        <span className="ml-2">Loading calendar...</span>
      </div>
    );
  }

  /** Error state - shows error message with retry button */
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

  /** No data state - shows when consultant details are not available */
  if (!consultantDetails) {
    return (
      <div className={`text-center p-8 text-muted-foreground ${className}`}>
        <Calendar className="h-12 w-12 mx-auto mb-4 opacity-50" />
        <p>No calendar data available</p>
      </div>
    );
  }

  // ===== MAIN RENDER =====

  return (
    <div className={` ${className} overflow-y-auto flex flex-col gap-4`}>
      {/* Calendar Header with View Controls and Navigation */}
      <div className="flex justify-between items-center gap-4">
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
                  : subMonths(currentDate, 1)
              )
            }
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="text-lg font-bold text-center min-w-[150px]">
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
                  : addMonths(currentDate, 1)
              )
            }
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        <div className="text-xs text-muted-foreground whitespace-nowrap">
          {eventType === "subscription" && mode === "allocate"
            ? `Subscription window: ${allowedStart ? allowedStart.toLocaleDateString() : "-"} – ${allowedEnd ? allowedEnd.toLocaleDateString() : "-"}`
            : null}
        </div>
      </div>

      {/* Allocation Action Buttons - Only shown in allocate mode */}
      {showAllocationButtons && mode === "allocate" && (
        <div className="flex gap-2 flex-wrap">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => autoAllocate(collectWeekAvailableSlots())}
                  disabled={isAllocating || eventType === "class"}
                >
                  <Zap className="h-4 w-4 mr-2" />
                  Auto Allocate
                </Button>
              </TooltipTrigger>
              {eventType === "class" && (
                <TooltipContent>
                  <p>Coming Soon!</p>
                </TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>

          {requestedSlots.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => preAllocate(requestedSlots)}
              disabled={isAllocating}
            >
              <Clock className="h-4 w-4 mr-2" />
              Use Requested Times
            </Button>
          )}

          <Button
            variant="outline"
            size="sm"
            onClick={clearSlots}
            disabled={isAllocating || selectedSlots.length === 0}
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            Clear Selection
          </Button>
          {/* Clear Allocated Slots action removed as per current requirements */}
        </div>
      )}

      {/* Reschedule (Subscriptions) */}
      {/* (moved below Timezone) */}

      {/* Main Calendar View - Week or Month */}
      {view === "week" ? (
        <div className="flex gap-4">
          <div className="flex-1 flex flex-col h-[calc(100vh-30rem)] md:h-[65vh] max-h-[400px] overflow-x-auto">
            {/* Week header */}
            <div className="grid grid-cols-8 gap-px md:gap-0.5 sticky top-0 bg-background z-20 pb-1 min-w-[800px]">
              <div className="w-12 md:w-16"></div>
              {weekDates.map((date, index) => {
                const isToday = isSameDay(date, new Date());
                return (
                  <div key={DAYS[index]} className="text-center p-1 md:p-1.5">
                    <div
                      className={`font-bold text-xs md:text-sm ${
                        isToday ? "text-primary" : ""
                      }`}
                    >
                      {DAYS[index].slice(0, 3)}{" "}
                      <span className="text-xs md:text-[13px] text-muted-foreground font-normal">
                        {format(date, "d")}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Week grid */}
            <div className="flex-1 overflow-y-auto scrollbar-thin min-h-0 max-h-96 min-w-[800px]">
              {INTERVALS.map((interval) => (
                <div
                  key={`interval-row-${interval.hour}-${interval.minute}`}
                  className="grid grid-cols-8 gap-px md:gap-0.5"
                >
                  <div className="w-12 md:w-16">
                    <div className="h-5 text-right pr-1.5 pt-0.5 text-[10px] md:text-[13px] flex items-start justify-end">
                      {new Date(
                        1970,
                        0,
                        1,
                        interval.hour,
                        interval.minute
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

          {showSubscriptionSidebar && eventType === "subscription" ? (
            <div className="w-64 shrink-0 border-l pl-3 pt-1 text-xs space-y-3">
              <div className="font-semibold">Subscription window</div>
              <div className="text-muted-foreground">
                {allowedStart ? allowedStart.toLocaleDateString() : "-"} –{" "}
                {allowedEnd ? allowedEnd.toLocaleDateString() : "-"}
              </div>
              <div className="pt-2">
                <div className="font-semibold mb-1">This week calls</div>
                {currentWeekCalls.length === 0 ? (
                  <div className="text-muted-foreground">None</div>
                ) : (
                  <ul className="space-y-1">
                    {currentWeekCalls.map((c) => (
                      <li
                        key={c.id}
                        className="flex items-center justify-between"
                      >
                        <span>
                          {c.start.toLocaleDateString()}{" "}
                          {c.start.toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                            hour12: false,
                          })}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        renderMonthView()
      )}

      {/* Footer with Progress Info and Action Buttons */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="text-sm">
            {(() => {
              try {
                if (eventType === "subscription") {
                  const computed = computeSubscriptionFooter({
                    selectedSlots,
                    allowedStart,
                    allowedEnd,
                    callsPerWeek,
                    sessionDurationInHours,
                    existingAppointments,
                    subscriptionId: eventId,
                  });
                  if (computed) return computed;
                  // Fallback to existing text if boundaries not provided
                  return calculateCallProgress(
                    selectedSlots,
                    sessionDurationInHours,
                    slotLimits.maxSlots
                  );
                } else if (eventType === "class") {
                  return computeClassFooter({
                    selectedSlots,
                    sessionDurationInHours,
                    totalSessions: slotLimits.totalSessions,
                    existingAppointments,
                    classId: eventId,
                    currentIntervals: currentEventIntervals,
                    allowedEnd,
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
                  duration
                );

                return `${selectedSlots.length} selected out of ${requiredSlotsForThisEvent} required slots`;
              } catch (error) {
                console.error("Error calculating footer stats:", error);
                if (error instanceof Error) {
                  return error.message;
                }
                return `Selected: ${selectedSlots.length} slots`;
              }
            })()}
          </div>
          <div className="text-xs text-muted-foreground">
            {eventType === "consultation"
              ? `Required: ${durationInHours || 1}h consultation (${Math.ceil((durationInHours || 1) / 0.5)} consecutive slots)`
              : eventType === "subscription"
                ? `Required: ${sessionDurationInHours || 1}h per call (${Math.ceil((sessionDurationInHours || 1) / 0.5)} consecutive slots per call)`
                : `Required: ${sessionDurationInHours || 1}h per session (2 consecutive slots)`}
          </div>
          {allocationError && (
            <div className="text-sm text-red-600">{allocationError}</div>
          )}
        </div>

        <div className="text-sm text-muted-foreground flex items-center gap-3 whitespace-nowrap">
          <span>Timezone: {browserTimezone}</span>
          {mode === "allocate" && (
            <div className="inline-flex items-center gap-2 ml-3">
              <Button
                onClick={() => setShowConfirmationDialog(true)}
                disabled={isAllocating || selectedSlots.length === 0}
                size="sm"
              >
                <Users className="h-4 w-4 mr-2" />
                {isAllocating ? "Validating..." : "Validate & Allocate"}
              </Button>
              {onCancel && (
                <Button variant="outline" size="sm" onClick={onCancel}>
                  Cancel
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Allocation Confirmation Dialog - Shows selected slots and allows final confirmation */}
      <AllocationConfirmationDialog
        open={showConfirmationDialog}
        onOpenChange={setShowConfirmationDialog}
        onConfirm={() => {
          setShowConfirmationDialog(false);
          console.log("[UnifiedCalendar] Confirm Allocation Clicked", {
            eventType,
            eventId,
            consultantId,
            durationInHours,
            sessionDurationInHours,
            callsPerWeek,
            durationInMonths,
            allowedStart,
            allowedEnd,
            selectedSlotsIso: selectedSlots.map((s) =>
              s.startTime.toISOString()
            ),
            selectedSlots,
            selectedPrevCallId,
          });

          // Check if this is a rescheduling operation for subscriptions or classes
          if (
            (eventType === "subscription" || eventType === "class") &&
            selectedPrevCallId &&
            eventId &&
            !selectedPrevCallId.startsWith("schedule_call_") // Not a new call scheduling
          ) {
            // Extract appointment ID and call timestamp from composite call ID (format: appointmentId::timestamp)
            const [appointmentId, callTimestamp] =
              selectedPrevCallId.split("::");
            console.log(
              `[UnifiedCalendar] Extracted appointment ID: ${appointmentId} and call timestamp: ${callTimestamp} from call ID: ${selectedPrevCallId}`
            );

            // Call reschedule API with specific call timestamp (for subscriptions) or appointment ID (for classes)
            manualAllocateWithReschedule(
              appointmentId,
              eventType === "subscription" ? callTimestamp : undefined
            );
          } else {
            // Regular manual allocation (includes new call scheduling)
            console.log(
              `[UnifiedCalendar] ${
                selectedPrevCallId?.startsWith("schedule_call_")
                  ? "Scheduling new call"
                  : "Regular allocation"
              } for ${eventType} ${eventId}`
            );
            manualAllocate();
          }
        }}
        onCancel={() => setShowConfirmationDialog(false)}
        selectedSlots={selectedSlots}
        eventType={eventType}
        eventTitle={undefined}
        consultantName={consultantDetails?.name}
        durationInHours={durationInHours}
        sessionDurationInHours={sessionDurationInHours}
        callsPerWeek={callsPerWeek}
        durationInMonths={durationInMonths}
        isAllocating={isAllocating}
        timezone={browserTimezone}
        // Pass reschedule options for subscriptions and classes - use existing appointments, not selected slots
        rescheduleOptions={
          (eventType === "subscription" || eventType === "class") &&
          existingAppointments.length > 0 &&
          eventId
            ? convertExistingAppointmentsToCalls(
                existingAppointments,
                eventId,
                eventType
              )
            : []
        }
        selectedRescheduleId={selectedPrevCallId || null}
        onChangeSelectedRescheduleId={(id) => setSelectedPrevCallId(id)}
        // Show schedule options based on plan's calls per week
        expectedTotalCalls={
          eventType === "subscription" || eventType === "class"
            ? callsPerWeek || 2
            : undefined
        }
      />
    </div>
  );
}
