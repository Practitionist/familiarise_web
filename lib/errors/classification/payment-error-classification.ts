/**
 * Centralized error classification for payment-related API routes.
 *
 * Separates *business-logic rejections* (expected, clean one-liner log)
 * from *infrastructure failures* (unexpected, full stack trace for debugging).
 *
 * Usage:
 *   import { classifyError, logClassifiedError } from "@/lib/payments/error-classification";
 *
 *   const classified = classifyError(error);
 *   logClassifiedError("Checkout", classified, error);
 */

import * as Sentry from "@sentry/nextjs";

// ============================================================================
// Error Types — used by both server routes and frontend toast mapping
// ============================================================================

export const ErrorTypes = {
  // Business-logic rejections (expected — user can fix or retry differently)
  EVENT_EXPIRED: "EVENT_EXPIRED_ERROR",
  AVAILABILITY: "AVAILABILITY_ERROR",
  DUPLICATE_REGISTRATION: "DUPLICATE_REGISTRATION_ERROR",
  NOT_FOUND: "NOT_FOUND_ERROR",
  REFUND_BLOCKED: "REFUND_BLOCKED_ERROR",
  LOCK_CONTENTION: "LOCK_CONTENTION_ERROR",
  UNSUPPORTED_CONFIG: "UNSUPPORTED_CONFIG_ERROR",

  // Infrastructure failures (unexpected — ops/dev needs to investigate)
  PAYMENT_CONFIG: "PAYMENT_CONFIG_ERROR",
  PAYMENT_PROCESSING: "PAYMENT_PROCESSING_ERROR",
  DATABASE: "DATABASE_ERROR",

  // Catch-all
  UNKNOWN: "UNKNOWN_ERROR",
} as const;

export type ErrorType = (typeof ErrorTypes)[keyof typeof ErrorTypes];

// ============================================================================
// Business-logic error patterns
// ============================================================================

/**
 * Each entry maps a keyword (matched case-insensitively against error.message)
 * to an ErrorType. Order matters — first match wins.
 */
export const BUSINESS_ERROR_PATTERNS: ReadonlyArray<{
  pattern: string;
  errorType: ErrorType;
}> = [
  // Event lifecycle
  { pattern: "already ended", errorType: ErrorTypes.EVENT_EXPIRED },
  { pattern: "has been cancelled", errorType: ErrorTypes.EVENT_EXPIRED },
  { pattern: "no longer accept", errorType: ErrorTypes.EVENT_EXPIRED },

  // Scheduling / availability
  { pattern: "has not been scheduled", errorType: ErrorTypes.AVAILABILITY },
  { pattern: "currently booking", errorType: ErrorTypes.AVAILABILITY },
  { pattern: "currently checking out", errorType: ErrorTypes.AVAILABILITY },
  // Consultee double-book (FAMILIARISE_WEB-P) — message has no "slot" substring.
  {
    pattern: "already have a session booked",
    errorType: ErrorTypes.AVAILABILITY,
  },
  { pattern: "slot", errorType: ErrorTypes.AVAILABILITY },
  { pattern: "availability", errorType: ErrorTypes.AVAILABILITY },
  { pattern: "capacity", errorType: ErrorTypes.AVAILABILITY },
  { pattern: "full", errorType: ErrorTypes.AVAILABILITY },

  // Duplicate registrations
  {
    pattern: "already registered",
    errorType: ErrorTypes.DUPLICATE_REGISTRATION,
  },
  { pattern: "already enrolled", errorType: ErrorTypes.DUPLICATE_REGISTRATION },

  // Not found
  { pattern: "not found", errorType: ErrorTypes.NOT_FOUND },

  // Refund guards
  {
    pattern: "already been paid out",
    errorType: ErrorTypes.REFUND_BLOCKED,
  },
  {
    pattern: "already been fully refunded",
    errorType: ErrorTypes.REFUND_BLOCKED,
  },
  {
    pattern: "exceeds available balance",
    errorType: ErrorTypes.REFUND_BLOCKED,
  },
  {
    pattern: "only successful payments",
    errorType: ErrorTypes.REFUND_BLOCKED,
  },

  // Discount / pricing validation
  { pattern: "discount code", errorType: ErrorTypes.AVAILABILITY },
  { pattern: "maximum uses", errorType: ErrorTypes.AVAILABILITY },
  { pattern: "minimum order", errorType: ErrorTypes.AVAILABILITY },
  { pattern: "below the", errorType: ErrorTypes.AVAILABILITY },
  { pattern: "percentage value must be", errorType: ErrorTypes.AVAILABILITY },

  // Org credit pool
  { pattern: "insufficient credits", errorType: ErrorTypes.AVAILABILITY },

  // Lock contention (payout batches, etc.)
  { pattern: "already in progress", errorType: ErrorTypes.LOCK_CONTENTION },

  // Config the schema understands but the runtime doesn't (e.g. PROJECT
  // funding source reserved for v2 — checkout must reject rather than
  // silently fall back to TAG_ONLY).
  {
    pattern: "funding source is not yet supported",
    errorType: ErrorTypes.UNSUPPORTED_CONFIG,
  },
] as const;

// ============================================================================
// Infrastructure error patterns
// ============================================================================

export const INFRA_ERROR_PATTERNS: ReadonlyArray<{
  patterns: string[];
  errorType: ErrorType;
  userMessage: string;
}> = [
  {
    patterns: ["Authentication failed", "Invalid API key"],
    errorType: ErrorTypes.PAYMENT_CONFIG,
    userMessage: "Payment gateway configuration error. Please contact support.",
  },
  {
    patterns: ["Prisma", "database"],
    errorType: ErrorTypes.DATABASE,
    userMessage: "Database error. Please try again or contact support.",
  },
  {
    patterns: ["Failed to create payment intent"],
    errorType: ErrorTypes.PAYMENT_PROCESSING,
    userMessage:
      "Payment processing unavailable. Please try again later or contact support.",
  },
] as const;

// ============================================================================
// Classifier
// ============================================================================

export interface ClassifiedError {
  /** Message to return to the client */
  errorMessage: string;
  /** Machine-readable error type for frontend toast mapping */
  errorType: ErrorType;
  /** true = expected rejection (warn), false = unexpected (error) */
  isBusinessError: boolean;
  /** Suggested HTTP status code */
  httpStatus: number;
}

/**
 * Classify an Error into a structured result for logging and response.
 *
 * @param error  - The caught error (can be any type)
 * @param fallbackMessage - Default message if error is not an Error instance
 */
export function classifyError(
  error: unknown,
  fallbackMessage = "An unexpected error occurred",
): ClassifiedError {
  if (!(error instanceof Error)) {
    return {
      errorMessage: fallbackMessage,
      errorType: ErrorTypes.UNKNOWN,
      isBusinessError: false,
      httpStatus: 500,
    };
  }

  const msg = error.message;

  // 1. Check infrastructure patterns first (these override user message)
  for (const { patterns, errorType, userMessage } of INFRA_ERROR_PATTERNS) {
    if (patterns.some((p) => msg.includes(p))) {
      return {
        errorMessage: userMessage,
        errorType,
        isBusinessError: false,
        httpStatus: 500,
      };
    }
  }

  // 2. Check business-logic patterns (pass through original message)
  const lowerMsg = msg.toLowerCase();
  for (const { pattern, errorType } of BUSINESS_ERROR_PATTERNS) {
    if (lowerMsg.includes(pattern)) {
      return {
        errorMessage: msg,
        errorType,
        isBusinessError: true,
        httpStatus:
          errorType === ErrorTypes.LOCK_CONTENTION
            ? 409
            : errorType === ErrorTypes.UNSUPPORTED_CONFIG
              ? 422
              : 400,
      };
    }
  }

  // 3. Unrecognised — treat as unexpected
  return {
    errorMessage: msg,
    errorType: ErrorTypes.UNKNOWN,
    isBusinessError: false,
    httpStatus: 500,
  };
}

// ============================================================================
// Logger helper
// ============================================================================

/**
 * Log a classified error with the right severity.
 *
 * @param tag     - Short route identifier, e.g. "Checkout", "Refunds"
 * @param result  - Output from classifyError()
 * @param error   - The original error (only printed for unexpected errors)
 */
export function logClassifiedError(
  tag: string,
  result: ClassifiedError,
  error: unknown,
): void {
  if (result.isBusinessError) {
    console.warn(`[${tag}] Business rule blocked: ${result.errorMessage}`);
  } else {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "payments" } });
    console.error(`[${tag}] Unexpected error:`, error);
  }
}
