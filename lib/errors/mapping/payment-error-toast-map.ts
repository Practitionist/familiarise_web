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

import {
  ErrorTypes,
  type ErrorType,
} from "../classification/payment-error-classification";

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
  // #1757 — capacity is a modelled refusal; the copy points at the two ways out.
  [ErrorTypes.EVENT_FULL]: {
    title: "This Session Is Full",
    description:
      "This session is full — pick another time or join the waitlist.",
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
  [ErrorTypes.UNSUPPORTED_CONFIG]: {
    title: "Configuration Not Supported",
    description: null, // Use the server's specific message
  },
  // #1351 — the server message names the env flag that fences the rail, which
  // is operator detail, so this entry carries its own description instead of
  // passing that through to the buyer.
  [ErrorTypes.GATEWAY_UNAVAILABLE]: {
    title: "This payment method is not available",
    description:
      "This payment method isn't available right now. Please go back and choose a different one.",
  },
  // #1426 — the buyer's card was never charged in any of these three
  // rejections, so each toast says so and points at the one action that
  // actually unblocks the buyer, instead of the generic gateway copy above.
  [ErrorTypes.SELF_BOOKING]: {
    title: "This Is Your Own Event",
    description:
      "You host or co-host this event, so you cannot book a seat on it.",
  },
  [ErrorTypes.WALLET_FROZEN]: {
    title: "Wallet On Hold",
    description:
      "Your organisation's wallet is frozen; ask your billing admin or support before booking again.",
  },
  // Checkout raises this for the booking member's own SESSION_BOOKING consent
  // on an org-funded booking; the checkout toast links to the fix (#1527 3c).
  [ErrorTypes.CONSENT_REQUIRED]: {
    title: "Your Consent Is Needed",
    description:
      "Your organisation can't book this session for you until you give session-booking consent in Settings › Account › Data consent. You were not charged.",
  },
  [ErrorTypes.CONSENT_WITHDRAWN]: {
    title: "Booking Not Available",
    description:
      "This consultant has paused bookings; your card was not charged.",
  },
  // #1407 — the fix is an admin action on the organisation, not a retry, so the
  // copy names it rather than inviting the buyer to try again.
  [ErrorTypes.DOMAIN_VERIFICATION_REQUIRED]: {
    title: "Domain Verification Required",
    description:
      "Invoice funding needs a verified domain on your organisation; ask your billing admin to verify it, or pay by card instead. Your card was not charged.",
  },
  // #1458 — the programme ran out of budget or was configured with a rail we do
  // not collect on. Neither is fixed by retrying, so each toast names the person
  // who can actually unblock the booking.
  [ErrorTypes.PROGRAM_CAP_EXHAUSTED]: {
    title: "Programme Budget Used Up",
    description:
      "Your organisation's programme budget for this cycle is used up; ask your admin or pay yourself if allowed.",
  },
  [ErrorTypes.PROGRAM_SESSION_CAP_REACHED]: {
    title: "Programme Session Cap Reached",
    description: null, // The server message already names the admin action.
  },
  [ErrorTypes.OVERAGE_CHARGE_MEMBER_UNSUPPORTED]: {
    title: "Programme Not Bookable Past Its Cap",
    description:
      "This programme is set to charge members for bookings past its cap, which is not available on a wallet-funded organisation. Ask your billing admin to switch the programme to charge the organisation or to block over-cap bookings.",
  },
  // #1467 — the organisation's entitlement, not the booking, is what stops
  // these. Retrying changes nothing, so each toast names the admin who can.
  [ErrorTypes.PROGRAM_ASSIGNMENT_INACTIVE]: {
    title: "No Programme Covers This Booking",
    description:
      "Your organisation has no active programme assignment for this session type, usually because its contract or programme has ended. Ask your organisation admin to assign you to a programme that covers it, or book it yourself. You were not charged.",
  },
  [ErrorTypes.BILLING_SUSPENDED_DUNNING]: {
    title: "Organisation Billing Suspended",
    description:
      "Your organisation has an overdue invoice, so new sponsored bookings are paused until it is paid. Ask your billing admin to settle it, or book this session yourself. You were not charged.",
  },
  // #1477 — the wallet is fine, it is simply short, so the copy asks for the
  // one action that clears it rather than inviting a retry that cannot succeed.
  [ErrorTypes.WALLET_INSUFFICIENT_FUNDS]: {
    title: "Wallet Balance Too Low",
    description:
      "Your organisation's wallet does not cover this booking. Ask your billing admin to top it up.",
  },
  // #1582 B-P1-01b/c — the server's userMessage already names the fix, so
  // these pass it through under a title that says whose action it is.
  [ErrorTypes.ORG_NOT_OPERATIONAL]: {
    title: "Organisation Cannot Sponsor Right Now",
    description: null,
  },
  [ErrorTypes.ORG_CANNOT_SPONSOR]: {
    title: "Sponsorship Not Enabled",
    description: null,
  },
  [ErrorTypes.ORG_MEMBERSHIP_REQUIRED]: {
    title: "Not An Active Member",
    description: null,
  },
  [ErrorTypes.ORG_CREDIT_LIMIT_REACHED]: {
    title: "Organisation Credit Limit Reached",
    description: null,
  },
  [ErrorTypes.CONSULTANT_NOT_ON_PANEL]: {
    title: "Consultant Not On Your Panel",
    description: null,
  },
  [ErrorTypes.CONSULTANT_EXCLUSIVE_ENGAGEMENT]: {
    title: "Consultant Books Through Their Organisation",
    description: null,
  },
  [ErrorTypes.SUBSCRIPTION_ALREADY_ACTIVE]: {
    title: "You Already Have This Plan",
    description: null,
  },
  [ErrorTypes.CURRENCY_UNSUPPORTED]: {
    title: "Currency Not Supported",
    description: null,
  },
  [ErrorTypes.CREDIT_SHORTFALL]: {
    title: "Credits Changed — Please Retry",
    description: null,
  },
  [ErrorTypes.DISCOUNT_CURRENCY_MISMATCH]: {
    title: "Discount Code Not Applicable",
    description: null,
  },
  [ErrorTypes.DISCOUNT_EXHAUSTED]: {
    title: "Discount Code Fully Redeemed",
    description: null,
  },
  // The verify route's non-2xx: the capture may still confirm by webhook, so
  // the copy must not claim the payment failed (PR-G makes verify emit it).
  [ErrorTypes.VERIFICATION_FAILED]: {
    title: "Payment Still Being Confirmed",
    description:
      "We could not verify the payment yet — it is still being confirmed. Check your bookings in a moment before paying again.",
  },
  [ErrorTypes.UNKNOWN]: {
    title: "Something Went Wrong",
    description: null, // Use the server's specific message
  },
  // #1775 / #1780 — each refusal's thrown sentence says what to do next.
  [ErrorTypes.BOOKING_RULE]: {
    title: "Not Available For This Booking",
    description: null,
  },
  // Contended checkout locks (literal codes from the route, not ErrorTypes
  // values until registered above): someone else is mid-checkout, so the fix
  // is waiting — never a second payment. Your card was not charged.
  [ErrorTypes.EVENT_CHECKOUT_BUSY]: {
    title: "Someone Just Beat You To It",
    description:
      "Another buyer is checking out right now. Wait a few seconds and retry — your card was not charged.",
  },
  [ErrorTypes.CONSULTEE_BOOKING_BUSY]: {
    title: "Booking Already In Progress",
    description:
      "Another booking is already in progress on your account. Finish or wait for it, then retry — your card was not charged.",
  },
  // #1319 — the server spent its Serializable budget (P2034 ×4) and the
  // transaction never committed. It ships `retryAfter: 2` and the client waits
  // and retries ONCE, so this entry is what the SECOND attempt reads; the
  // first already toasted the during-wait notice. Not a fault and nothing was
  // charged, so the copy says the retry is worth making rather than "went wrong".
  [ErrorTypes.SERIALIZATION_CONFLICT]: {
    title: "The Booking System Was Busy",
    description:
      "Another booking was being written at the same time. Your card was not charged — please try again in a moment.",
  },
  // B4 — the optimistic capacity pre-check. Terminal until someone cancels, so
  // this is deliberately NOT a "wait and retry" and points at the two ways out
  // (a different time, or the waitlist) exactly like the #1757 EVENT_FULL row.
  [ErrorTypes.EVENT_SOLD_OUT]: {
    title: "This Session Is Full",
    description:
      "This session is full — pick another time or join the waitlist. Your card was not charged.",
  },
  // The two fail-closed lock refusals (CN-1, #1169 PR 1). Distinct from the
  // BUSY rows above on purpose: nobody holds the lock, the locking service
  // itself is unreachable, so the booking was refused rather than delayed. Same
  // action though — wait and retry — so the copy says exactly that and never
  // implies the buyer did anything.
  [ErrorTypes.EVENT_CHECKOUT_LOCK_UNAVAILABLE]: {
    title: "The Booking System Is Briefly Busy",
    description:
      "We couldn't secure a place for you in the queue for this session. Your card was not charged — please try again in a moment.",
  },
  [ErrorTypes.BOOKING_LOCK_UNAVAILABLE]: {
    title: "The Booking System Is Briefly Busy",
    description:
      "We couldn't take the booking safely just now. Your card was not charged — please try again in a moment.",
  },
  // #1583 E-P1-03 — the client's own start instant, refused at the Zod edge
  // 400ms after the page rendered. The server's sentence is the good one here
  // (it names the minutes left and the lead time), so the description passes it
  // through and only the title is added: a learner who sat on the pay page was
  // never told the listing stopped being available, only that their chosen
  // minute had passed.
  [ErrorTypes.SLOT_TOO_SOON]: {
    title: "That Time Is Now Too Close",
    description: null, // The server names how many minutes are left; keep its words.
  },
  [ErrorTypes.SLOT_NOT_ON_GRID]: {
    title: "That Time Isn't Bookable",
    description: null, // "Times start on the hour or half hour" — already exact.
  },
};

// ============================================================================
// Typed `code` → toast, for codes that ride BESIDE an errorType
// ============================================================================

/**
 * #1583 E-P1-03 — some routes answer a typed refusal as `{ error, code,
 * errorType }` where `errorType` is a coarse bucket (`AVAILABILITY_ERROR`)
 * and `code` is the specific reason. Resolving on `errorType` alone is what
 * titled a lead-time refusal "No Longer Available"; the `code` is the half of
 * the answer that knows what actually happened, so `getErrorToast` reads it
 * first when a caller has it.
 *
 * Kept beside the refund map rather than folded into `ERROR_TOAST_MAP` because
 * these are the SAME values as ErrorTypes entries — the map is looked up by
 * string precisely because the caller cannot know which key a given route
 * chose to send.
 */
const TYPED_CODE_TOAST_MAP: Record<string, ToastMessage> = {
  [ErrorTypes.SLOT_TOO_SOON]: ERROR_TOAST_MAP[ErrorTypes.SLOT_TOO_SOON],
  [ErrorTypes.SLOT_NOT_ON_GRID]: ERROR_TOAST_MAP[ErrorTypes.SLOT_NOT_ON_GRID],
};

// ============================================================================
// Gateway refund codes
// ============================================================================

/**
 * #1352 — `RefundError.code` values are minted by the gateway adapter and
 * travel to the client as `code`, never through `classifyError`. They therefore
 * arrived here as an unrecognised string and fell straight through to
 * "Something Went Wrong".
 *
 * `REFUND_IN_FLIGHT` is the one where that was actively misleading. Razorpay
 * answers 409 on a duplicate idempotency key while the original refund is still
 * settling, which means the refund IS happening — telling the operator (or the
 * customer) that something went wrong invites them to issue a second one.
 */
const REFUND_CODE_TOAST_MAP: Record<string, ToastMessage> = {
  REFUND_IN_FLIGHT: {
    title: "Refund Already In Progress",
    description:
      "Your refund is already being processed and does not need to be requested again. " +
      "It can take a few moments to settle with the bank — refresh this page shortly to see the updated status.",
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
 *
 * `errorType` is a string rather than the `ErrorType` union because API routes
 * also return gateway-minted `RefundError.code` values here (#1352); those are
 * matched first, then the classified error types, then the UNKNOWN fallback.
 *
 * `typedCode` is the `{ code }` half of an answer that also carries a coarse
 * `errorType` (#1583 E-P1-03). It is consulted BEFORE `errorType` and only when
 * the body actually typed the refusal — a generic code must never outrank a
 * specific errorType.
 */
export function getErrorToast(
  errorType: string,
  serverMessage?: string,
  typedCode?: string | null,
): { title: string; description: string } {
  const typedEntry = typedCode ? TYPED_CODE_TOAST_MAP[typedCode] : undefined;
  const entry =
    typedEntry ??
    REFUND_CODE_TOAST_MAP[errorType] ??
    ERROR_TOAST_MAP[errorType as ErrorType] ??
    ERROR_TOAST_MAP[ErrorTypes.UNKNOWN];

  const description =
    entry.description ??
    serverMessage ??
    FALLBACK_DESCRIPTIONS[(typedCode ?? errorType) as ErrorType] ??
    FALLBACK_DESCRIPTIONS[ErrorTypes.UNKNOWN]!;

  return { title: entry.title, description };
}
