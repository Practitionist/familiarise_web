/**
 * Single catalog for every user-facing message in the slot-allocation flow so
 * the week view, month view, and requests table never drift in wording.
 * Limit messages say "this day/this week" instead of naming the bucket date:
 * limits bucket by the event's scheduling timezone (see
 * SlotCalculationService, ADR B9), which for a viewer in a different
 * timezone is not always the calendar day they see on the grid.
 */

export interface AllocationToast {
  title: string;
  description: string;
  variant: "default" | "destructive";
}

const plural = (n: number) => (n === 1 ? "" : "s");

/** "Jul 20, 2026" for a "YYYY-MM-DD" scheduling-timezone day key. */
export function formatDayKey(dayKey: string): string {
  const d = new Date(`${dayKey}T00:00:00.000Z`);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}

/** "week of Jul 19, 2026" for a week key ("YYYY-MM-DD" of the week's Sunday). */
export function formatWeekKey(weekKey: string): string {
  return `week of ${formatDayKey(weekKey.split("T")[0])}`;
}

// --- interactive selection guards ---

export const weeklyLimitReached = (sessionsPerWeek: number): AllocationToast => ({
  variant: "destructive",
  title: "Weekly limit reached",
  description: `You can only schedule ${sessionsPerWeek} session${plural(sessionsPerWeek)} per week. This week is full — choose a different week.`,
});

export const dailyLimitReached = (maxPerDay: number): AllocationToast => ({
  variant: "destructive",
  title: "Daily limit reached",
  description: `You can only schedule ${maxPerDay} session${plural(maxPerDay)} per day. Choose a different day.`,
});

export const oneSessionPerDay = (): AllocationToast => ({
  variant: "destructive",
  title: "One session per day",
  description:
    "You can only schedule one session per day. Please choose a different day.",
});

export const sessionLimitReached = (maxTotal: number): AllocationToast => ({
  variant: "destructive",
  title: "Session limit reached",
  description: `You've already selected all ${maxTotal} session${plural(maxTotal)}. Remove a session to choose a different time.`,
});

export const allSessionsSelected = (): AllocationToast => ({
  variant: "destructive",
  title: "All sessions selected",
  description:
    "You've selected all the required time slots. Click 'Allocate' to confirm.",
});

export const completeSessionFirst = (): AllocationToast => ({
  variant: "destructive",
  title: "Complete this session first",
  description:
    "Select the next consecutive time slot to finish the session you've started.",
});

export const consecutiveRequired = (): AllocationToast => ({
  variant: "destructive",
  title: "Slots must be consecutive",
  description:
    "Each session requires back-to-back time slots on the same day. Select the immediately following slot.",
});

export const invalidSelection = (reason: string): AllocationToast => ({
  variant: "destructive",
  title: "Invalid selection",
  description: reason,
});

export const outsideSchedulingWindow = (rangeText: string): AllocationToast => ({
  variant: "destructive",
  title: "Outside scheduling window",
  description: `Slots can only be selected within the scheduling period (${rangeText}).`,
});

export const pastSlotBlocked = (): AllocationToast => ({
  variant: "destructive",
  title: "Slot has passed",
  description: "This slot is no longer available.",
});

export const pastSessionBlocked = (): AllocationToast => ({
  variant: "destructive",
  title: "Past session",
  description:
    "This session has already passed. Navigate to a future week to schedule a replacement.",
});

export const sessionTooSoon = (): AllocationToast => ({
  variant: "destructive",
  title: "Session too soon",
  description:
    "This session starts within 24 hours and cannot be rescheduled.",
});

export const sessionBeingRescheduled = (): AllocationToast => ({
  variant: "default",
  title: "Session being rescheduled",
  description:
    "This is the session you're rescheduling — pick a new available time for it.",
});

export const slotUnavailable = (isBooked: boolean): AllocationToast => ({
  variant: "destructive",
  title: "Slot unavailable",
  description: isBooked
    ? "This slot is already booked."
    : "This slot is not available.",
});

export const notEnoughConsecutive = (
  requiredSlots: number,
  availableHere: number,
): AllocationToast => ({
  variant: "destructive",
  title: "Not enough consecutive slots",
  description: `Each session requires ${(requiredSlots * 30) / 60} hours (${requiredSlots} consecutive slots). Only ${availableHere} available here.`,
});

// --- selection progress ---

export const sessionAdded = (
  completed: number,
  total: number,
): AllocationToast => ({
  variant: "default",
  title: "Session added",
  description: `${completed} of ${total} session${plural(total)} selected — ${total - completed} more to go.`,
});

export const keepGoing = (
  remainingInCall: number,
  sessionNumber: number,
): AllocationToast => ({
  variant: "default",
  title: "Keep going",
  description: `Select ${remainingInCall} more consecutive slot${plural(remainingInCall)} to complete session ${sessionNumber}.`,
});

// --- allocation outcomes ---

export const timingsSaved = (): AllocationToast => ({
  variant: "default",
  title: "Timings saved",
  description: "Sessions have been scheduled successfully.",
});

export const autoScheduled = (): AllocationToast => ({
  variant: "default",
  title: "Sessions auto-scheduled",
  description: "All sessions have been automatically scheduled.",
});

export const allocationFailed = (reason: string): AllocationToast => ({
  variant: "destructive",
  title: "Couldn't save timings",
  description: reason,
});

/** 409 — another tab or teammate already allocated this request. "Session"
 * is deliberately avoided here: it means a bookable session everywhere else
 * in this dialog. */
export const allocatedElsewhere = (): AllocationToast => ({
  variant: "destructive",
  title: "Already allocated",
  description:
    "This request was already allocated in another tab or by a teammate. Refreshing the list.",
});

/** Request left the allocatable state (declined/cancelled) in another tab. */
export const requestChangedElsewhere = (): AllocationToast => ({
  variant: "destructive",
  title: "Request changed",
  description:
    "This request was updated in another tab or by a teammate and can no longer be allocated. Refreshing the list.",
});

/** Plan data anomaly: no totalSessions and no scheduling period. */
export const planConfigIncomplete = (): AllocationToast => ({
  variant: "destructive",
  title: "Plan configuration incomplete",
  description:
    "This request's plan is missing its session count and scheduling period, so slots can't be allocated. Contact support.",
});
