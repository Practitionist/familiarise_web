/**
 * Shared types for the unified slot allocation system
 *
 * This file consolidates all types used across allocation services to ensure
 * consistency and reduce duplication.
 */

import type { AppointmentStatus } from "@prisma/client";
import type { Tx } from "@/lib/prisma";
import type { ApprovalLock } from "@/utils/appointmentlock";
import type { StagedTrigger } from "@/lib/novu/outbox";
import type { PendingOverageNotification } from "@/lib/payments/billing/overage-settlement";
import type { AppointmentWithSlots } from "@/lib/booking/allocation/types";
import type { NullableWeeklyRowLocalColumns } from "@/utils/schedule/weekly-projection";

/**
 * Allocation modes supported by the system
 */
export type AllocationMode = "auto" | "manual" | "requested";

/**
 * Event types that can be allocated
 */
export type EventType = "consultation" | "subscription" | "webinar" | "class";

/**
 * Event types that are recurring (have multiple sessions over time).
 * Used to guard past-session subtraction, reallocation logic, etc.
 */
export const RECURRING_EVENT_TYPES: ReadonlyArray<EventType> = [
  "class",
  "subscription",
] as const;

/** Type-safe check for whether an event type is recurring */
export function isRecurringEventType(eventType: string): boolean {
  return (RECURRING_EVENT_TYPES as ReadonlyArray<string>).includes(eventType);
}

/**
 * Whether a slot row is a reschedule release — released by the reschedule
 * route and still awaiting replacement times.
 *
 * Canonical predicate, shared by the dashboard gates and the allocator. Tentativeness
 * alone is NOT the signal: every fresh request also carries tentative holds
 * (request-for-approval and unpaid checkout create them that way), and those
 * times ARE the request. Only `tentative + RESCHEDULED` means "moved away
 * from, needs a new time". Gating on tentativeness painted "needs new times"
 * on every fresh approval (E2E on preview #1682).
 */
export function isReleasedForReschedule(slot: {
  isTentative?: boolean | null;
  completionStatus?: string | null;
  /**
   * Tombstoned rows keep their flags: a cancelled-then-tombstoned release
   * still reads tentative + RESCHEDULED. Such a row is history, not a live
   * hold awaiting replacement — callers that only carry the two status
   * fields (dashboard list shapes) pass undefined, which counts as live.
   */
  deletedAt?: Date | string | null;
}): boolean {
  return (
    slot.isTentative === true &&
    slot.completionStatus === "RESCHEDULED" &&
    (slot.deletedAt === null || slot.deletedAt === undefined)
  );
}

/**
 * Request structure for slot allocation
 */
/** What an allocation freed and placed, handed to `inTx` in the same transaction. */
export interface AllocationMove {
  consultantProfileId: string;
  /** Released windows the allocation replaced (a reschedule); empty otherwise. */
  freedWindows: { startsAt: Date; endsAt: Date }[];
  /** The occurrences the allocation wrote. */
  placed: { startsAt: Date; endsAt: Date }[];
}

export interface AllocationRequest {
  eventType: EventType;
  eventId: string;
  mode: AllocationMode;
  slots?: string[]; // ISO date strings for manual allocation
  // #837 — client-supplied dedupe key (Idempotency-Key header). A double-submit
  // carrying the same key returns the first batch instead of allocating twice.
  idempotencyKey?: string;
  // Multi-tab guard — when true, reject (409) if the event already has
  // confirmed slots instead of replacing them. Auto and manual take different
  // Redis lock keys (#860), so a cross-mode race from two tabs otherwise ends
  // in the manual path silently deleting the winner's allocation.
  initialAllocation?: boolean;
  /**
   * #1012 — reschedule stale-tab guard. When set, the current tentative slot
   * count must match exactly; otherwise another tab already completed (or
   * mutated) the reschedule and this submit would delete+recreate confirmed
   * slots. Fresh allocations omit the field.
   */
  expectedTentativeSlotCount?: number;
  /**
   * Consultant's explicit acceptance of times outside their own published
   * availability. Routes must only set this for the consultant or a privileged
   * caller — a consultee cannot wave away the consultant's schedule.
   */
  override?: boolean;
  /**
   * #1206 — place every session that FITS instead of refusing the whole
   * allocation when the window cannot hold them all. Off by default: a partial
   * schedule is the consultant's explicit decision, taken after the shortfall
   * has been shown to them. Only recurring events (subscription, class) can be
   * partial — a consultation or webinar is one session, so it either fits or
   * it does not.
   */
  allowPartial?: boolean;
  /**
   * #1206 — place ONLY the sessions an earlier partial allocation left
   * unplaced, treating every confirmed appointment as fixed. Off by default
   * because the ordinary auto path is a re-plan: it deletes what exists and
   * lays the whole schedule out again. That is right for a reschedule and
   * catastrophic for an event whose earlier sessions are already booked and
   * paid. Honoured only for a recurring event that already has confirmed
   * sessions and no reschedule in flight; every other shape falls through to
   * today's behaviour unchanged.
   */
  topUp?: boolean;
  /**
   * #1340 — the reschedule proposal this allocation IS the confirmation of.
   *
   * Placing replacement times supersedes every OTHER open proposal on the same
   * released slots, so the allocator closes those as DECLINED. The confirming
   * caller's own proposal used to be in that set: it was DECLINED inside the
   * allocator's transaction, and the caller's following
   * `PENDING_REVIEW → AUTO_ACCEPTED/ACCEPTED` CAS then matched zero rows. The
   * booking had moved while its audit trail read "declined", auto-confirm
   * reported `autoConfirmed: false`, and the explicit accept answered 409 with
   * no MOVED notification. Set only by the two confirmation callers.
   */
  excludeRescheduleRequestId?: string;
  /** Narrows the request statuses the approval CAS accepts (1:1 events only). */
  approvableFrom?: AppointmentStatus[];
  /** Runs inside the allocator's transaction after the status CAS; a throw rolls the move back. */
  inTx?: (tx: Tx, moved: AllocationMove) => Promise<void>;
  /**
   * The caller already holds this booking's appointment lock (reschedule
   * accept and auto-confirm): the allocator renews it instead of acquiring it.
   */
  heldAppointmentLock?: ApprovalLock;
  /** The hourly top-up placing a plan's open week as the system, not a person. */
  bySweep?: boolean;
  /**
   * The plan's own consultant placed the sessions. Only then can a first
   * placement record the plan's Auto choice; any other caller (staff, a host
   * or sponsor org operator, or a door that does not say) is a one-off.
   */
  byConsultant?: boolean;
}

/** The per-call extras every allocation mode threads into its transaction. */
export type AllocationTxOptions = Pick<
  AllocationRequest,
  "approvableFrom" | "inTx"
> & {
  /** The `reason` the approval's history row records (`scheduleReason`). */
  historyReason?: string;
};

/**
 * Result of validation check
 */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  /**
   * The conflicts behind the `[CONFLICT]` strings, structured so the validate
   * routes can name the booking and its other party without parsing prose
   * (the grid PR links them). Present only when the conflict check ran.
   */
  conflicts?: ConflictDetail[];
}

export interface ConflictDetail {
  /** Seconds-precision UTC ISO of the proposed slot, as the routes report it. */
  slot: string;
  appointmentId: string;
  type: "Consultation" | "Subscription" | "Webinar" | "Class" | "Booking";
  /** On the consultant's own calendar; otherwise the consultee is the busy party. */
  onConsultantCalendar: boolean;
}

/**
 * Result of slot conflict checking — shared across all 4 event validate API routes,
 * the allocationService utility, and the RequestedSlotsDialog component.
 *
 * Routes with extra fields (subscription, class, dialog) extend this base.
 */
export interface SlotConflictResult {
  conflicts: Array<{
    slot: string;
    existingAppointment: {
      type: string;
      with: string;
      time: string;
      /** The conflicting booking, only when it is the viewing consultant's own. */
      appointmentId?: string;
    };
  }>;
  outsideAvailability: Array<{
    slot: string;
  }>;
  /** Slots that start inside the lead time (or have passed): never valid. */
  tooSoon?: Array<{
    slot: string;
  }>;
  validSlots: string[];
}

/**
 * Structured error codes for allocation failures.
 * Routes use this instead of string-prefix checks to determine HTTP status.
 */
export type AllocationErrorCode =
  | "VALIDATION_ERROR" // bad input from caller — 400
  | "NOT_FOUND" // event/consultant missing — 400
  | "INVALID_MODE" // unknown allocation mode — 400
  | "LOCK_CONTENTION" // Redis lock busy / replay in flight — 409
  | "ALREADY_ALLOCATED" // confirmed slots already exist for this event — 409
  | "RESCHEDULE_STATE_CHANGED" // #1012 stale-tab tentative count moved — 409
  | "SLOT_TAKEN" // a chosen time went to someone else mid-allocation — 409
  | "TIMES_TAKEN" // a picked time is held by another writer right now — 409
  | "ALLOCATION_RACE" // auto found no free times after its re-searches; retryable — 409
  | "AVAILABILITY_CHANGED" // the host's published availability shrank under the allocation — 409
  | "IDEMPOTENCY_KEY_REUSE" // same Idempotency-Key, different payload — 422
  | "ILLEGAL_TRANSITION" // event left the approvable state mid-allocation (#836) — 409
  | "PROGRAM_CAP_EXHAUSTED" // org's per-cycle overage ceiling vetoed it — 402
  | "NO_AVAILABILITY" // consultant has no published availability — 400
  | "PERIOD_ENDED" // scheduling period is in the past — 400
  | "SLOT_SHORTAGE" // not enough free slots in the window — 400
  | "COLLABORATOR_UNAVAILABLE" // AE-2 (#784) — a co-host is already committed — 409
  | "SUBSCRIPTION_UNPAID" // #1775 C-1 — a plan with no settled payment is never approved — 409
  | "CHECKOUT_IN_PROGRESS" // the buyer's own direct checkout is still being paid — 409
  | "TOO_CLOSE_TO_START" // an unpaid approval whose first session starts too soon to pay — 409
  | "RESCHEDULE_NO_LONGER_OPEN" // the confirmed proposal was answered or expired mid-move — 409
  | "PROPOSAL_AWAITING_CLIENT" // the consultant's own proposal with times is still open — 409
  | "SESSION_HAS_REMEDY" // a session to be re-planned carries an incident remedy — 409
  | "USE_RETIME" // a webinar or class with a live seat is re-timed, never re-planned — 409
  | "BOOKING_LOCK_UNAVAILABLE" // the locking service is down; retry shortly — 503
  | "SEARCH_TIMEOUT" // the auto search ran out of time before placing every session — 503
  | "UNKNOWN_ERROR"; // infra / unexpected — 500

/**
 * Result of allocation operation
 */
export interface AllocationResult {
  success: boolean;
  /**
   * #1775 B-9 — where a consultation / subscription approval landed:
   * `approved` (a settled wrapper) or `awaiting_payment` (the pay order is
   * minted after the commit). Absent for group events and on failure.
   */
  outcome?: "approved" | "awaiting_payment";
  /**
   * #1697 item 5 — outbox rows staged inside the write transaction.
   * `allocate` (lib/booking/allocation) strips this and attempts them post-commit;
   * it never reaches a route response.
   */
  stagedNotices?: StagedTrigger[];
  /** A subscription allocation's member-due overage notice; `allocate` sends it after commit. */
  overageNotice?: PendingOverageNotification | null;
  appointments?: AppointmentWithSlots[]; // Appointment records created
  error?: string;
  errorCode?: AllocationErrorCode;
  httpStatus?: number;
  warnings?: string[];
  // AE-4 — appointment ids whose tentative slots were freed during a partial
  // reschedule, so callers (calendar refresh, notifications) know what to drop.
  deletedAppointmentIds?: string[];
  /**
   * #1206 — fewer sessions than the plan requires were placed, at the
   * consultant's explicit request. Derived at read time from confirmed
   * sessions vs the plan's total; nothing is persisted.
   */
  partial?: boolean;
  placedSessions?: number;
  requiredSessions?: number;
  unplacedSessions?: number;
  /**
   * #1206 — a top-up run that wrote nothing: either the plan is already fully
   * scheduled or the consultant's availability still has no room. Success, not
   * a failure, and the one signal the notification suppressor reads — the
   * hourly sweep re-attempts every incomplete event, so a notice on a run that
   * changed nothing would page the consultee every hour forever.
   */
  noChange?: boolean;
  /**
   * #1206 — on a SLOT_SHORTAGE refusal: how many whole sessions the search
   * COULD have placed. Zero means offering a partial allocation is pointless.
   */
  placeableSessions?: number;
  /** On TIMES_TAKEN: the 30-minute interval starts (ISO) another writer holds. */
  takenSlotStarts?: string[];
  /** On ALLOCATION_RACE: when a retry may succeed. */
  retryAfterSeconds?: number;
}

/**
 * A computed, plan-length cut of availability shown in the picker; transient (#1554).
 */
export interface BookableInterval {
  startTime: Date;
  endTime: Date;
  isAvailable: boolean;
  isBooked: boolean;
}

/**
 * Progress information for UI display
 */
export interface ProgressInfo {
  scheduled: number; // Number of calls/sessions scheduled
  required: number; // Total required
  remaining: number; // Remaining to schedule
  sessionDuration: number; // In hours
  displayText: string; // Formatted text for UI
}

/**
 * Consultant profile data needed for allocation
 */
export interface ConsultantAllocationData {
  userId: string;
  scheduleType: "WEEKLY" | "CUSTOM";
  /** Projected from the local columns only; NULL ones are refused by every reader. */
  availabilityWindowsWeekly: Array<
    { id: string } & NullableWeeklyRowLocalColumns
  >;
  availabilityWindowsCustom: Array<{
    id: string;
    startsAt: Date;
    endsAt: Date;
  }>;
  /** Whether any custom row is published, when the rows above are only the live window. */
  hasCustomRows?: boolean;
  timezone?: string;
}

/**
 * Event configuration for allocation
 */
export interface EventConfig {
  durationInMonths?: number;
  durationInHours?: number; // For consultations/webinars (total duration)
  sessionDurationInHours?: number; // For subscriptions/classes (per session)
  sessionsPerWeek?: number; // For subscriptions/classes
  totalSessions?: number; // Authoritative session count from subscription plan
  /** #1766 — sessions this allocation may place: the subscription's current
   * cycle `nextBatch`. When set, the period below is that cycle's window. */
  cycleTargetSessions?: number;
  schedulingPeriodStartsAt?: Date; // For subscriptions/classes
  schedulingPeriodEndsAt?: Date; // For subscriptions/classes
  // Timezone defining the limit day/week buckets (ADR B9). Subscription/Class
  // column; consultations/webinars fall back to the helper default.
  schedulingTimezone?: string;
}
