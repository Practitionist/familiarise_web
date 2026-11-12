/**
 * Typed error classes for slot allocation.
 *
 * Used by classifyError() (lib/booking/allocation/classify.ts) to map errors to HTTP status
 * codes via instanceof checks instead of brittle string-prefix matching.
 */

import { AllocationErrorCode } from "./types";

export abstract class AllocationError extends Error {
  abstract readonly httpStatus: number;
  abstract readonly errorCode: AllocationErrorCode;

  /**
   * `message` is plain user copy. `details` is developer detail (times as
   * ISO, internal tags, counts) for logs and Sentry only, never a response.
   */
  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** 400 — validation failures, bad input, business rule violations.
 * The optional code override lets callers distinguish cause-specific
 * sub-types (NO_AVAILABILITY, PERIOD_ENDED, SLOT_SHORTAGE) while keeping
 * the same HTTP status. */
export class AllocationValidationError extends AllocationError {
  readonly httpStatus = 400 as const;
  readonly errorCode: AllocationErrorCode;
  constructor(
    message: string,
    code: AllocationErrorCode = "VALIDATION_ERROR",
    details?: Record<string, unknown>,
  ) {
    super(message, details);
    this.errorCode = code;
  }
}

/**
 * 400 — SLOT_SHORTAGE, carrying how many WHOLE sessions the search COULD place
 * (#1206). Without that number the client can only say "not enough free
 * slots"; with it, it can offer the consultant the choice between waiting and
 * placing what fits now.
 */
export class SlotShortageError extends AllocationValidationError {
  constructor(
    message: string,
    readonly placeableSessions: number,
    readonly requiredSessions: number,
  ) {
    super(message, "SLOT_SHORTAGE");
  }
}

/** 400 — event or consultant not found */
export class AllocationNotFoundError extends AllocationError {
  readonly httpStatus = 400 as const;
  readonly errorCode = "NOT_FOUND" as const;
}

/** The 409 family: clients branch on these, never on message text. */
export type AllocationConflictCode = Extract<
  AllocationErrorCode,
  | "LOCK_CONTENTION"
  | "ALREADY_ALLOCATED"
  | "RESCHEDULE_STATE_CHANGED"
  | "SLOT_TAKEN"
  | "TIMES_TAKEN"
  | "ALLOCATION_RACE"
  | "AVAILABILITY_CHANGED"
  | "RESCHEDULE_NO_LONGER_OPEN"
  | "SESSION_HAS_REMEDY"
  | "PROPOSAL_AWAITING_CLIENT"
  | "USE_RETIME"
>;

/** 409 — lock contention, duplicate booking race, already allocated */
export class AllocationConflictError extends AllocationError {
  readonly httpStatus = 409 as const;
  readonly errorCode: AllocationConflictCode;
  constructor(
    message: string,
    code: AllocationConflictCode = "LOCK_CONTENTION",
    details?: Record<string, unknown>,
  ) {
    super(message, details);
    this.errorCode = code;
  }
}

/**
 * 422 — same Idempotency-Key reused with a different payload (Stripe-style
 * fingerprint mismatch: the key's stamped batch does not match this request's
 * slots). A retry must reuse the key AND the payload; a changed payload needs
 * a fresh key. The client mints one automatically via the attempt fingerprint.
 */
export class AllocationIdempotencyMismatchError extends AllocationError {
  readonly httpStatus = 422 as const;
  readonly errorCode = "IDEMPOTENCY_KEY_REUSE" as const;
}

/**
 * 503 — the auto search stopped at its time budget before placing every
 * session. Not a shortage: the calendar may have room, so a retry (or a manual
 * pick) can succeed.
 */
export class SearchTimeoutError extends AllocationError {
  readonly httpStatus = 503 as const;
  readonly errorCode = "SEARCH_TIMEOUT" as const;
  constructor(details?: Record<string, unknown>) {
    super(
      "This calendar is taking too long to search. Try again, or pick the times yourself.",
      details,
    );
  }
}
