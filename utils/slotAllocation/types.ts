/**
 * Shared types for the unified slot allocation system
 *
 * This file consolidates all types used across allocation services to ensure
 * consistency and reduce duplication.
 */


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
 * Request structure for slot allocation
 */
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
}

/**
 * Result of validation check
 */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
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
    };
  }>;
  outsideAvailability: Array<{
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
  | "LOCK_CONTENTION" // Redis lock busy — 409
  | "ILLEGAL_TRANSITION" // event left the approvable state mid-allocation (#836) — 409
  | "UNKNOWN_ERROR"; // infra / unexpected — 500

/**
 * Result of allocation operation
 */
export interface AllocationResult {
  success: boolean;
  appointments?: any[]; // Appointment records created
  error?: string;
  errorCode?: AllocationErrorCode;
  httpStatus?: number;
  warnings?: string[];
  // AE-4 — appointment ids whose tentative slots were freed during a partial
  // reschedule, so callers (calendar refresh, notifications) know what to drop.
  deletedAppointmentIds?: string[];
}

/**
 * Time slot representation
 */
export interface TimeSlot {
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
  slotsOfAvailabilityWeekly: Array<{
    id: string;
    startDay: string;
    startTimeUtc: number;
    endDay: string;
    endTimeUtc: number;
    utcOffsetMinutes: number;
  }>;
  slotsOfAvailabilityCustom: Array<{
    id: string;
    startsAt: Date;
    endsAt: Date;
  }>;
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
  schedulingPeriodStartsAt?: Date; // For subscriptions/classes
  schedulingPeriodEndsAt?: Date; // For subscriptions/classes
  // Timezone defining the limit day/week buckets (ADR B9). Subscription/Class
  // column; consultations/webinars fall back to the helper default.
  schedulingTimezone?: string;
}
