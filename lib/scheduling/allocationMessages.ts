/**
 * Single catalog for every user-facing message in the slot-allocation flow so
 * the week view, month view, and requests table never drift in wording.
 * Limits bucket by the event's scheduling timezone (ScheduleCalculationService,
 * ADR B9), which for a viewer in a different timezone is not always the
 * calendar day they see on the grid. #1076 — the cap messages used to hide
 * behind a vague "this day/this week"; when the zones differ they now name
 * the scheduling bucket and translate its span onto the viewer's clock.
 */

import {
  formatClockTime,
  formatDateTimeLabel,
  formatDayLabel,
  type DisplayOpts,
} from "@/lib/time/display";
import { ScheduleCalculationService } from "@/utils/scheduling-engine/ScheduleCalculationService";
import { REQUEST_INDETERMINATE_ERROR } from "./allocationService";
import type { JustTakenReason } from "./week-grid-model";

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

// --- #1076 limit buckets ---

/** The scheduling-timezone day/week bucket a cap rejection is about. */
export interface LimitBucket {
  kind: "day" | "week";
  /** UTC instants bounding the bucket. */
  start: Date;
  end: Date;
  /** "Jul 20, 2026" / "week of Jul 19, 2026" — the bucket as scheduled. */
  label: string;
  /** RESOLVED scheduling timezone (never undefined — the default counts). */
  timeZone: string;
}

export function schedulingDayBucket(
  at: Date,
  schedulingTimezone?: string,
): LimitBucket {
  const timeZone =
    schedulingTimezone ??
    ScheduleCalculationService.DEFAULT_SCHEDULING_TIMEZONE;
  const start = ScheduleCalculationService.startOfDayInTz(at, timeZone);
  // +26h lands inside the NEXT bucket whatever DST did (a day is 23-25h),
  // then snaps back to its start — so the end is exact, not start+24h.
  const end = ScheduleCalculationService.startOfDayInTz(
    new Date(start.getTime() + 26 * 3_600_000),
    timeZone,
  );
  return {
    kind: "day",
    start,
    end,
    label: formatDayKey(ScheduleCalculationService.dayKey(at, timeZone)),
    timeZone,
  };
}

export function schedulingWeekBucket(
  at: Date,
  schedulingTimezone?: string,
): LimitBucket {
  const timeZone =
    schedulingTimezone ??
    ScheduleCalculationService.DEFAULT_SCHEDULING_TIMEZONE;
  const start = ScheduleCalculationService.startOfWeekSundayInTz(at, timeZone);
  // 7 days + 2h: early into the following Sunday across any DST shift.
  const end = ScheduleCalculationService.startOfWeekSundayInTz(
    new Date(start.getTime() + 170 * 3_600_000),
    timeZone,
  );
  return {
    kind: "week",
    start,
    end,
    label: formatWeekKey(ScheduleCalculationService.weekKey(at, timeZone)),
    timeZone,
  };
}

const viewerTimezone = (): string | undefined =>
  typeof Intl !== "undefined"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : undefined;

/**
 * " Days are counted in Asia/Kolkata: this day is Jul 20, 2026, Jul 19,
 * 11:30 PM – Jul 20, 11:30 PM on your clock." — appended to a cap rejection
 * so the bucket that filled up is nameable and locatable on the viewer's own
 * clock. Empty when the zones agree: there is nothing to explain, the bucket
 * is the day/week the viewer already sees.
 */
export function limitBucketNote(bucket?: LimitBucket): string {
  if (!bucket || viewerTimezone() === bucket.timeZone) return "";
  const fmt = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const span = `${fmt.format(bucket.start)} – ${fmt.format(bucket.end)} on your clock`;
  return bucket.kind === "day"
    ? ` Days are counted in ${bucket.timeZone}: this day is ${bucket.label}, ${span}.`
    : ` Weeks are counted in ${bucket.timeZone}: this ${bucket.label} runs ${span}.`;
}

// --- interactive selection guards ---

export const weeklyLimitReached = (
  sessionsPerWeek: number,
  bucket?: LimitBucket,
): AllocationToast => ({
  variant: "destructive",
  title: "Weekly limit reached",
  description: `You can only schedule ${sessionsPerWeek} session${plural(sessionsPerWeek)} per week. This week is full — choose a different week.${limitBucketNote(bucket)}`,
});

export const dailyLimitReached = (
  maxPerDay: number,
  bucket?: LimitBucket,
): AllocationToast => ({
  variant: "destructive",
  title: "Daily limit reached",
  description: `You can only schedule ${maxPerDay} session${plural(maxPerDay)} per day. Choose a different day.${limitBucketNote(bucket)}`,
});

export const oneSessionPerDay = (bucket?: LimitBucket): AllocationToast => ({
  variant: "destructive",
  title: "One session per day",
  description: `You can only schedule one session per day. Please choose a different day.${limitBucketNote(bucket)}`,
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

export const outsideSchedulingWindow = (
  rangeText: string,
): AllocationToast => ({
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
  description: "This session starts within 24 hours and cannot be rescheduled.",
});

export const sessionBeingRescheduled = (): AllocationToast => ({
  variant: "default",
  title: "Session being rescheduled",
  description:
    "This is the session you're rescheduling — pick a new available time for it.",
});

export const otherSessionOfBooking = (): AllocationToast => ({
  variant: "default",
  title: "Another session of this booking",
  description:
    "That time is a session of this booking you are not moving. Pick a free time, or choose that session to move it as well.",
});

/** A pick the latest data no longer allows was removed: says which rule removed it. */
export function selectionDropped(
  reasons: readonly JustTakenReason[],
): AllocationToast {
  if (reasons.includes("taken")) {
    return {
      variant: "destructive",
      title: "One of your chosen times was just taken",
      description:
        "That time is no longer free, so it has been removed — pick another time.",
    };
  }
  if (reasons.includes("ownSession")) {
    return {
      variant: "destructive",
      title: "One of your chosen times is another session of this booking",
      description:
        "That session is not being moved, so the time has been removed — pick another time.",
    };
  }
  return {
    variant: "destructive",
    title: "One of your chosen times can't be booked any more",
    description:
      "It is now too close to its start or past this plan's limit. It has been removed — pick another time.",
  };
}

export const slotUnavailable = (isBooked: boolean): AllocationToast => ({
  variant: "destructive",
  title: "Slot unavailable",
  description: isBooked
    ? "This slot is already booked. Try another time."
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

// #1705 — one title for every "it worked" outcome. Manual, auto and
// requested-times approvals used to answer with three different headlines
// for the same fact; the description carries what differs.
// An unpaid request is held, not confirmed: the toast names the pay link's end
// when this call minted one, and otherwise only that the learner must pay.
export const timingsSaved = (
  result: { awaitingPayment?: boolean; payExpiresAt?: Date | null } = {},
  opts?: DisplayOpts,
): AllocationToast => {
  if (result.awaitingPayment !== true) {
    return {
      variant: "default",
      title: "Sessions scheduled",
      description: "The times you picked are confirmed.",
    };
  }
  return {
    variant: "default",
    title: "Times held",
    description: result.payExpiresAt
      ? `The learner has until ${formatDateTimeLabel(result.payExpiresAt, opts)} to pay. The sessions are confirmed once they do.`
      : "The learner has to pay before the sessions are confirmed.",
  };
};

export const autoScheduled = (): AllocationToast => ({
  variant: "default",
  title: "Sessions scheduled",
  description: "All sessions were placed automatically.",
});

export const timesConfirmed = (): AllocationToast => ({
  variant: "default",
  title: "Sessions scheduled",
  description: "The requested times are confirmed.",
});

/**
 * #1206 — the consultant asked for a partial placement and got one. Says how
 * many sessions are still unscheduled, because "scheduled" on its own would
 * read as the whole plan.
 */
export const partiallyScheduled = (
  placed: number,
  required: number,
): AllocationToast => {
  // The remainder needs its own noun and its own agreement: a shortfall of one
  // is the common near-complete case, and "The remaining 1 stay unscheduled"
  // is what the consultant read there.
  const remaining = Math.max(0, required - placed);
  return {
    variant: "default",
    title: "Some sessions scheduled",
    description: `${placed} of ${required} session${plural(required)} now have times. The remaining ${remaining} session${plural(remaining)} ${remaining === 1 ? "stays" : "stay"} unscheduled until more availability opens.`,
  };
};

/** `title` names the action that failed; the Timings page's is the default. */
export const allocationFailed = (
  reason: string,
  title = "Couldn't save timings",
): AllocationToast => ({
  variant: "destructive",
  title,
  description: reason,
});

/**
 * PR 2c resilience (audit gap #5) — cause-specific toasts keyed by the
 * server's structured errorCode. The raw message still renders as the
 * description, but the title tells the consultant WHY without parsing
 * internal error strings. Falls back to `allocationFailed` for unknown
 * codes so nothing silently loses its copy.
 */
const ALLOCATION_ERROR_TOASTS: Record<
  string,
  { title: string; variant: "destructive" | "default" }
> = {
  NO_AVAILABILITY: {
    title: "No availability published",
    variant: "destructive",
  },
  PERIOD_ENDED: {
    title: "The scheduling period has ended",
    variant: "destructive",
  },
  SLOT_SHORTAGE: {
    title: "Not enough free slots",
    variant: "destructive",
  },
  IDEMPOTENCY_KEY_REUSE: {
    title: "Request changed — please resubmit",
    variant: "destructive",
  },
  PROGRAM_CAP_EXHAUSTED: {
    title: "Programme budget used up",
    variant: "destructive",
  },
  COLLABORATOR_UNAVAILABLE: {
    title: "Co-host unavailable",
    variant: "destructive",
  },
  USE_RETIME: {
    title: "This event already has booked seats, so move it instead",
    variant: "destructive",
  },
  // ILLEGAL_TRANSITION and RESCHEDULE_STATE_CHANGED are deliberately absent:
  // both 409s route to requestChangedElsewhere() (qa-1702, #1705).
  SLOT_TAKEN: {
    title: "That time was just taken — pick another",
    variant: "destructive",
  },
  LOCK_CONTENTION: {
    title: "Another change is in progress — retry in a moment",
    variant: "destructive",
  },
  // #1583 E-P1-03 — the client's own picked start, refused at the Zod edge
  // (schemas/slots.ts → request-for-approval, schemas/checkout.ts → the buy).
  // These reach the allocate dialog too, because a consultant re-submitting a
  // consultee's requested time hits the same edge. The server's sentence is the
  // good one (it names the minutes left, or the :00/:30 grid), so it rides as
  // the description and only the title is added — "Couldn't save timings" under
  // "that time is now too close" would send the consultant hunting for a
  // permissions problem they do not have.
  SLOT_TOO_SOON: {
    title: "That time is now too close",
    variant: "destructive",
  },
  SLOT_NOT_ON_GRID: {
    title: "That time isn't bookable",
    variant: "destructive",
  },
  // #1169 PR 1 / CN-1 — the booking locks fail CLOSED on a Redis outage and
  // answer 503 with this code. Nothing was written and the request is still
  // allocatable, so this is the same "wait and retry" story LOCK_CONTENTION
  // tells, said once for a lock nobody is holding.
  BOOKING_LOCK_UNAVAILABLE: {
    title: "The booking system is briefly busy — retry in a moment",
    variant: "destructive",
  },
};

/** Shared 429 copy: every limiter answers it, every surface renders it. */
export const rateLimited = (retryAfterSecs?: number): AllocationToast => ({
  variant: "destructive",
  title: "Too many attempts",
  description:
    typeof retryAfterSecs === "number" && retryAfterSecs > 0
      ? `Please wait ${retryAfterSecs}s, then retry.`
      : "Please wait a moment, then retry.",
});

export const allocationFailedWithCode = (
  reason: string,
  errorCode?: string,
  title?: string,
): AllocationToast => {
  if (errorCode && ALLOCATION_ERROR_TOASTS[errorCode]) {
    return {
      ...ALLOCATION_ERROR_TOASTS[errorCode],
      description: reason,
    } as AllocationToast;
  }
  return allocationFailed(reason, title);
};

/**
 * Why a sold webinar or class is not re-planned on Timings, and what moves it:
 * the event page's move control, which is not offered inside the reschedule lead.
 */
export function soldEventMoveCopy(
  eventType: "webinar" | "class",
  /** `RESCHEDULE_MIN_LEAD_HOURS`, passed in to keep this module free of the payments imports. */
  leadHours: number,
  liveSeats?: number,
): string {
  const plural = liveSeats === 1 ? "" : "s";
  const seats =
    liveSeats === undefined
      ? "booked seats"
      : `${liveSeats} booked seat${plural}`;
  const control =
    eventType === "class" ? "Move upcoming sessions" : "Move to a new date";
  const inside =
    eventType === "class"
      ? `A session that starts within ${leadHours} hours can't be moved: cancel that session and schedule a make-up instead.`
      : `Inside ${leadHours} hours of the start it can't be moved at all: cancel it instead, and everyone is refunded in full.`;
  return (
    `This ${eventType} already has ${seats}, so its times can't be re-planned here. ` +
    `Use "${control}" on the event page: attendees are told and may leave with a full refund. ${inside}`
  );
}

/** A consultation with a confirmed time moves only through Reschedule. */
export const ALREADY_SCHEDULED_COPY =
  "This booking already has a time. Use Reschedule to move it.";

/** 409 on a consultation: it already has a confirmed time, however it got one. */
export const alreadyScheduled = (): AllocationToast => ({
  variant: "destructive",
  title: "Already has a time",
  description: ALREADY_SCHEDULED_COPY,
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

/** A 409 named the times someone else took; the rest of the picks stand. */
export const timesJustTaken = (
  starts: readonly Date[],
  zone?: string,
): AllocationToast => ({
  variant: "destructive",
  title:
    starts.length === 1
      ? "This time was just taken"
      : "These times were just taken",
  description: `${starts
    .map(
      (start) =>
        `${formatDayLabel(start, { zone })} ${formatClockTime(start, { zone })}`,
    )
    .join(", ")}. Your other picks are still selected — choose replacements.`,
});

/** The taken starts a 409 TIMES_TAKEN names, as valid dates. */
export function takenStartsFrom(starts: readonly string[] | undefined): Date[] {
  return (starts ?? [])
    .map((iso) => new Date(iso))
    .filter((date) => Number.isFinite(date.getTime()));
}

/** A reschedule's picked times were taken first; the booking kept its time. */
export const rescheduleTimesTaken = (
  starts: readonly Date[],
  zone?: string,
): AllocationToast => ({
  variant: "destructive",
  title:
    starts.length <= 1
      ? "This time was just taken"
      : "These times were just taken",
  // The allocator's refusal does not always name which start was taken.
  description: `${
    starts.length > 0
      ? `${starts
          .map(
            (start) =>
              `${formatDayLabel(start, { zone })} ${formatClockTime(start, { zone })}`,
          )
          .join(", ")}. `
      : ""
  }Your booking keeps its original time — pick another time.`,
});

/** The request's tentative times moved in another tab; the page reloaded them. */
export const requestRefreshedInPlace = (): AllocationToast => ({
  variant: "destructive",
  title: "This request just changed",
  description:
    "Its times were updated in another tab or by a teammate. The calendar has been refreshed — check the times and save again.",
});

/** Plan data anomaly: no totalSessions and no scheduling period. */
export const planConfigIncomplete = (): AllocationToast => ({
  variant: "destructive",
  title: "Plan configuration incomplete",
  description:
    "This request's plan is missing its session count and scheduling period, so slots can't be allocated. Contact support.",
});

// --- #1705 requested-times validation copy ---

export const SIGN_IN_PATH = "/auth/signin";

/** Sign-in with the current page as callbackUrl, so the consultant lands
 * back on the request they were confirming. */
export function signInHref(currentPath: string): string {
  return `${SIGN_IN_PATH}?callbackUrl=${encodeURIComponent(currentPath)}`;
}

export type ValidationFailureKind =
  "session-ended" | "forbidden" | "indeterminate" | "retry-later" | "refused";

/**
 * What a failed validate call means for the dialog. A 401 is now reserved
 * for a session that really ended; a failed session lookup answers 503
 * `SESSION_LOOKUP_FAILED` (#1716), which — like every 503, a refusal with a
 * sentence and nothing done — reads as "try again in a moment" rather than
 * as an unknown outcome.
 *
 * #1863 — audited for a code-first branch and deliberately left on the status.
 * The typed validate refusals (`SLOT_TOO_SOON`, `SLOT_NOT_ON_GRID`, raised at
 * the Zod edge in schemas/slots.ts) answer 400 WITH a sentence naming the
 * minutes left or the :00/:30 grid, and every 4xx already lands on "refused",
 * whose copy branch relays `serverMessage` verbatim. A `code` parameter here
 * would classify them no differently and would be a second, decorative
 * mechanism. The codes that DID need branching live where the branch changes
 * something visible: `ALLOCATION_ERROR_TOASTS` above (the title) and
 * `classifyAllocationFailure` (whether the dialog closes).
 */
export function classifyValidationFailure(
  httpStatus: number | undefined,
): ValidationFailureKind {
  if (httpStatus === 401) return "session-ended";
  if (httpStatus === 403) return "forbidden";
  if (httpStatus === 503) return "retry-later";
  if (httpStatus === undefined || httpStatus >= 500) return "indeterminate";
  return "refused";
}

const RETRY_LATER_FALLBACK = "The server is busy — try again in a moment.";

export function validationFailureCopy(
  kind: ValidationFailureKind,
  serverMessage: string,
): string {
  switch (kind) {
    case "session-ended":
      return "Your session has ended — sign in again.";
    case "forbidden":
      return "You can't schedule this booking.";
    case "indeterminate":
      return REQUEST_INDETERMINATE_ERROR;
    case "retry-later":
      return serverMessage || RETRY_LATER_FALLBACK;
    default:
      return serverMessage;
  }
}
