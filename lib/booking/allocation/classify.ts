// Maps an allocation failure to its error code and HTTP status, and says
// whether it is a modelled answer or a fault.

import { AllocationErrorCode } from "@/utils/scheduling-engine/types";
import { isExclusionViolation } from "@/lib/db/pg-errors";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import {
  AllocationValidationError,
  AllocationNotFoundError,
  AllocationConflictError,
  AllocationIdempotencyMismatchError,
  SearchTimeoutError,
} from "@/utils/scheduling-engine/errors";
import { ProgramAssignmentLimitError } from "@/lib/api/organizations/program-helpers";
import { CollaboratorUnavailableError } from "@/lib/collaborators/availability";

/**
 * Whether `error` is one of the modelled business outcomes this engine
 * throws for ordinary reasons (validation, not-found, lock/CAS contention,
 * an org cap reached) rather than an actual fault. Both branches are
 * reported to Sentry (full-coverage policy); this only decides the
 * level/tag so a modelled answer never reads as a fault on the dashboard.
 * An outage (lock service down, search out of time) is never modelled.
 */
export function isModeledOutcome(error: unknown): boolean {
  return (
    error instanceof AllocationValidationError ||
    error instanceof AllocationNotFoundError ||
    error instanceof AllocationConflictError ||
    error instanceof AllocationIdempotencyMismatchError ||
    error instanceof IllegalTransitionError ||
    error instanceof BookingRuleError ||
    error instanceof ProgramAssignmentLimitError ||
    isExclusionViolation(error) ||
    // AE-2 (#784) — a co-host already committed elsewhere is a scheduling
    // answer, not a fault.
    error instanceof CollaboratorUnavailableError ||
    // Another writer holds a booking lock right now.
    isLockBusy(error)
  );
}

/**
 * Classifies an unknown error into a structured error code and HTTP status.
 * Called from the allocate() catch block to avoid string-prefix checks in routes.
 */
export function classifyError(error: unknown): {
  errorCode: AllocationErrorCode;
  httpStatus: number;
} {
  // Typed error classes — primary classification mechanism
  if (error instanceof AllocationValidationError) {
    return { errorCode: error.errorCode, httpStatus: error.httpStatus };
  }
  if (error instanceof AllocationNotFoundError) {
    return { errorCode: error.errorCode, httpStatus: error.httpStatus };
  }
  if (error instanceof AllocationConflictError) {
    return { errorCode: error.errorCode, httpStatus: error.httpStatus };
  }
  if (error instanceof AllocationIdempotencyMismatchError) {
    return { errorCode: error.errorCode, httpStatus: error.httpStatus };
  }
  // #1775 C-1 — an unpaid plan; the allocation rolled back.
  if (
    error instanceof BookingRuleError &&
    (error.code === "SUBSCRIPTION_UNPAID" ||
      error.code === "CHECKOUT_IN_PROGRESS" ||
      error.code === "TOO_CLOSE_TO_START" ||
      error.code === "EXPERT_NOT_VERIFIED")
  ) {
    return { errorCode: error.code, httpStatus: error.httpStatus };
  }
  // #836 — consultee cancelled (or request expired) while the consultant
  // was allocating; the whole allocation tx rolled back.
  if (error instanceof IllegalTransitionError) {
    return { errorCode: "ILLEGAL_TRANSITION", httpStatus: error.httpStatus };
  }

  // The org's per-cycle overage ceiling refusing an assignment is a decision,
  // not a fault. It was already reported to Sentry as an expected outcome
  // while falling through to UNKNOWN_ERROR/500 here — so the dashboard called
  // it routine and the caller got a server error. 402 matches what
  // recordOverageAtCheckout returns for the very same ceiling.
  if (error instanceof ProgramAssignmentLimitError) {
    return { errorCode: "PROGRAM_CAP_EXHAUSTED", httpStatus: 402 };
  }

  // AE-2 (#784) — a co-host's clash is a conflict, and the crud-with-plan
  // routes already answer 409 for the identical rejection.
  if (error instanceof CollaboratorUnavailableError) {
    return { errorCode: "COLLABORATOR_UNAVAILABLE", httpStatus: 409 };
  }
  // Lock refusals by class: a held key is contention (409, retry); the
  // locking service being down is an outage (503) and a fault.
  const lockCode = lockErrorCode(error);
  if (lockCode === "EVENT_CHECKOUT_BUSY") {
    return { errorCode: "EVENT_CHECKOUT_BUSY", httpStatus: 409 };
  }
  if (
    lockCode === "BOOKING_LOCK_UNAVAILABLE" ||
    lockCode === "EVENT_CHECKOUT_LOCK_UNAVAILABLE"
  ) {
    return { errorCode: "BOOKING_LOCK_UNAVAILABLE", httpStatus: 503 };
  }
  if (isLockBusy(error)) {
    return { errorCode: "LOCK_CONTENTION", httpStatus: 409 };
  }
  if (error instanceof SearchTimeoutError) {
    return { errorCode: "SEARCH_TIMEOUT", httpStatus: 503 };
  }

  // A unique or exclusion violation that reached here unclassified: the
  // overlap constraint is a taken slot; any other constraint is a fault.
  if (isExclusionViolation(error)) {
    return { errorCode: "SLOT_TAKEN", httpStatus: 409 };
  }
  return { errorCode: "UNKNOWN_ERROR", httpStatus: 500 };
}

/**
 * The lock family's refusals, by the stable `code` each error class carries
 * (utils/appointmentlock.ts), never by message text.
 */
const LOCK_BUSY_CODES: ReadonlySet<string> = new Set([
  "APPOINTMENT_BUSY",
  "AUTO_ALLOCATE_BUSY",
  "CONSULTEE_BOOKING_BUSY",
  "EVENT_CHECKOUT_BUSY",
  "LOCK_CONTENTION",
  "LOCK_LOST",
]);

function lockErrorCode(error: unknown): string | null {
  if (!(error instanceof Error) || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function isLockBusy(error: unknown): boolean {
  const code = lockErrorCode(error);
  return code !== null && LOCK_BUSY_CODES.has(code);
}
