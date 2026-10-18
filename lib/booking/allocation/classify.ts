// Maps an allocation failure to its error code and HTTP status, and says
// whether it is a modelled answer or a fault.

import { AllocationErrorCode } from "@/utils/scheduling-engine/types";
import { isExclusionViolation, isUniqueViolation } from "@/lib/db/pg-errors";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import {
  AllocationValidationError,
  AllocationNotFoundError,
  AllocationConflictError,
  AllocationIdempotencyMismatchError,
} from "@/utils/scheduling-engine/errors";
import { ProgramAssignmentLimitError } from "@/lib/api/organizations/program-helpers";
import { CollaboratorUnavailableError } from "@/lib/collaborators/availability";

/**
 * Whether `error` is one of the modelled business outcomes this engine
 * throws for ordinary reasons (validation, not-found, lock/CAS contention,
 * an org cap reached) rather than an actual fault. Both branches are
 * reported to Sentry (full-coverage policy); this only decides the
 * level/tag so a modelled answer never reads as a fault on the dashboard.
 * Deliberately narrower than classifyError()'s message-sniffing fallback,
 * which exists only to pick an HTTP status for legacy untyped throws and
 * would otherwise also mark real bugs "expected" if the message happens to
 * contain "not found".
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
    isUniqueViolation(error) ||
    isExclusionViolation(error) ||
    // AE-2 (#784) — a co-host already committed elsewhere is a scheduling
    // answer, not a fault.
    error instanceof CollaboratorUnavailableError
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
    error.code === "SUBSCRIPTION_UNPAID"
  ) {
    return { errorCode: "SUBSCRIPTION_UNPAID", httpStatus: error.httpStatus };
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

  // Structured DB-conflict detection (no message sniffing): unique (P2002 /
  // 23505) and the #440 exclusion constraint (23P01). createAppointments
  // already rethrows these as a typed AllocationConflictError at the source;
  // this is the safety net for the conflict paths that don't (e.g. the
  // requested-slots isTentative flip).
  if (isUniqueViolation(error) || isExclusionViolation(error)) {
    return { errorCode: "LOCK_CONTENTION", httpStatus: 409 };
  }

  // Last-resort fallback for untyped throws from legacy code paths. Matching on
  // message text is fragile; migrating these callers to typed errors is #837.
  const msg = error instanceof Error ? error.message : "";
  if (
    msg.includes("lock") ||
    msg.includes("Lock") ||
    msg.includes("in progress")
  ) {
    return { errorCode: "LOCK_CONTENTION", httpStatus: 409 };
  }
  if (msg.includes("not found") || msg.includes("no consultant")) {
    return { errorCode: "NOT_FOUND", httpStatus: 400 };
  }
  return { errorCode: "UNKNOWN_ERROR", httpStatus: 500 };
}
