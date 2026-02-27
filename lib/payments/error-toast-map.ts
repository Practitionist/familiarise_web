/**
 * Client-side error type → toast message mapping.
 *
 * Maps the machine-readable `errorType` returned by API routes
 * to user-friendly toast titles and descriptions.
 *
 * Usage:
 *   import { getErrorToast } from "@/lib/payments/error-toast-map";
 *
 *   const { title, description } = getErrorToast(errorType, errorMessage);
 */

import { ErrorTypes, type ErrorType } from "./error-classification";

// ============================================================================
// Toast message definitions
// ============================================================================

interface ToastMessage {
  title: string;
  /** Static description. When null, the raw error message is used. */
  description: string | null;
}

const ERROR_TOAST_MAP: Record<ErrorType, ToastMessage> = {
  [ErrorTypes.PAYMENT_CONFIG]: {
    title: "Payment System Unavailable",
    description:
      "We're unable to connect to the payment system right now. This is a temporary issue on our end. Please try again in a few minutes, or contact support if the problem persists.",
  },
  [ErrorTypes.PAYMENT_PROCESSING]: {
    title: "Payment Could Not Be Processed",
    description:
      "Your payment couldn't be completed. This could be due to insufficient funds, an invalid card, or a temporary bank issue. Please check your payment details and try again, or use a different payment method.",
  },
  [ErrorTypes.DATABASE]: {
    title: "Unable to Save Your Booking",
    description:
      "We encountered an issue while saving your information. Your payment has not been processed. Please refresh the page and try again. If this continues, contact support.",
  },
  [ErrorTypes.NOT_FOUND]: {
    title: "Booking Information Not Found",
    description: null, // Use the server's specific message
  },
  [ErrorTypes.EVENT_EXPIRED]: {
    title: "Event Has Ended",
    description: null, // Use the server's specific message
  },
  [ErrorTypes.AVAILABILITY]: {
    title: "No Longer Available",
    description: null, // Use the server's specific message
  },
  [ErrorTypes.DUPLICATE_REGISTRATION]: {
    title: "Already Registered",
    description:
      "You're already registered for this event! Check your dashboard to view your registration details and upcoming sessions.",
  },
  [ErrorTypes.REFUND_BLOCKED]: {
    title: "Refund Not Allowed",
    description: null, // Use the server's specific message
  },
  [ErrorTypes.LOCK_CONTENTION]: {
    title: "Operation In Progress",
    description: null, // Use the server's specific message
  },
  [ErrorTypes.UNKNOWN]: {
    title: "Something Went Wrong",
    description: null, // Use the server's specific message
  },
};

// ============================================================================
// Fallback descriptions (used when the toast entry has description: null
// AND no server error message is available)
// ============================================================================

const FALLBACK_DESCRIPTIONS: Partial<Record<ErrorType, string>> = {
  [ErrorTypes.NOT_FOUND]:
    "The item you're trying to book could not be found. It may have been removed or is no longer available. Please go back and select a different option.",
  [ErrorTypes.EVENT_EXPIRED]:
    "This event has already ended or been cancelled and is no longer accepting registrations. Please browse other upcoming events.",
  [ErrorTypes.AVAILABILITY]:
    "This booking is no longer available. Someone else may have just booked it, or the schedule has changed. Please go back and select a different time slot or option.",
  [ErrorTypes.UNKNOWN]:
    "An unexpected error occurred while processing your request. Please try again. If the problem continues, take a screenshot of this message and contact support.",
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Resolve an errorType + optional message into a toast-ready { title, description }.
 */
export function getErrorToast(
  errorType: string,
  serverMessage?: string,
): { title: string; description: string } {
  const entry =
    ERROR_TOAST_MAP[errorType as ErrorType] ??
    ERROR_TOAST_MAP[ErrorTypes.UNKNOWN];

  const description =
    entry.description ??
    serverMessage ??
    FALLBACK_DESCRIPTIONS[errorType as ErrorType] ??
    FALLBACK_DESCRIPTIONS[ErrorTypes.UNKNOWN]!;

  return { title: entry.title, description };
}
