import type { BookingMode } from "@prisma/client";

/**
 * #1775 / #1780 — the booking-money refusals this train adds. Each is a state
 * the caller can act on, never a fault, so each carries its own code and a
 * 409 (or 400) and is registered in BUSINESS_ERROR_CODES for the toast map.
 */
export type BookingRuleCode =
  | "SUBSCRIPTION_UNPAID"
  | "TRIAL_UNPAID"
  | "PAYMENT_LINK_FAILED"
  | "PAYMENT_ALREADY_EXISTS"
  | "ALREADY_PAID"
  | "REFUND_WINDOW_CLOSED"
  | "SESSION_NOT_CANCELLABLE"
  | "MAKEUP_WINDOW_LAPSED"
  | "MAKEUP_EXISTS"
  | "MAKEUP_NOT_SKIPPABLE"
  | "EVENT_TIME_INVALID"
  | "EXIT_NOT_AVAILABLE"
  | "BACKUP_INTEREST_CAP"
  | "BACKUP_WINDOW_PAST"
  | "ENROLMENT_CLOSED"
  | "CLASS_PRICE_CHANGED"
  | "PLAN_NOT_PUBLISHED"
  | "PLAN_ARCHIVED"
  | "SCHEDULE_CONFLICT"
  | "WINDOW_DURATION_MISMATCH"
  | "SEAT_REBUY_UNSUPPORTED"
  | "NOT_ACCEPTING_BOOKINGS"
  | "REQUEST_APPROVAL_REQUIRED"
  | "PLAN_CLIENTS_FULL"
  | "EXPERT_NOT_VERIFIED"
  | "ALREADY_REGISTERED"
  | "RETURN_WINDOW_CLOSED"
  | "RETURN_CAP_REACHED"
  | "RETURN_RESCHEDULE_OPEN"
  | "SESSION_NOT_RETURNABLE"
  | "DISPUTE_ACTIVE"
  | "INCIDENT_REMEDY_NOT_FOUND"
  | "INCIDENT_REMEDY_CLOSED"
  | "INCIDENT_REMEDY_WRONG_KIND"
  | "INCIDENT_REBOOK_SLOT_UNAVAILABLE"
  | "INVALID_PLAN_START"
  | "CHECKOUT_IN_PROGRESS"
  | "TOO_CLOSE_TO_START"
  | "RETIME_NOT_ALLOWED"
  | "RETIME_TOO_SOON"
  | "USE_RESCHEDULE_RESPOND"
  | "REQUEST_TOO_SOON"
  | "REQUEST_NOT_OFFERED"
  | "USE_CANCEL_ENDPOINT"
  | "PLACE_RELEASED_SESSIONS"
  | "PAYMENT_BUSY"
  | "EVENT_NOT_FOUND"
  | "EVENT_CLOSED"
  | "EVENT_NOT_FULL"
  | "WAITLIST_DISABLED"
  | "WAITLIST_FULL"
  | "EVENT_WAITLIST_CAP"
  | "REMOVAL_NOT_ALLOWED"
  | "REMOVAL_ALREADY_LIFTED"
  | "REMOVAL_CONFLICT"
  | "EVENT_BUSY"
  | "LIFT_NOT_ALLOWED";

export class BookingRuleError extends Error {
  constructor(
    readonly code: BookingRuleCode,
    message: string,
    readonly httpStatus = 409,
  ) {
    super(message);
    this.name = "BookingRuleError";
  }
}

/** A direct 1:1 checkout refused because the expert reviews requests first. */
export const REQUEST_APPROVAL_REQUIRED_MESSAGE =
  "This expert reviews requests before you pay. Send a request for this time instead. You have not been charged.";

const NOT_ACCEPTING_BOOKINGS_MESSAGE =
  "This expert is not taking new 1:1 bookings right now. Pick another expert, or try again later.";

/**
 * The expert's two switches a direct checkout obeys: a pause stops 1:1s and plans, review-first
 * stops 1:1s. Pricing, the in-lock re-read and the commit all ask this, so a flip refuses alike.
 */
export function assertExpertTakesDirectCheckout(
  appointmentType: string,
  profile: { acceptingRequests: boolean; bookingMode: BookingMode } | null,
): void {
  const oneToOne =
    appointmentType === "CONSULTATION" || appointmentType === "SUBSCRIPTION";
  if (oneToOne && profile?.acceptingRequests === false) {
    throw new BookingRuleError(
      "NOT_ACCEPTING_BOOKINGS",
      NOT_ACCEPTING_BOOKINGS_MESSAGE,
    );
  }
  if (
    appointmentType === "CONSULTATION" &&
    profile?.bookingMode === "REQUEST"
  ) {
    throw new BookingRuleError(
      "REQUEST_APPROVAL_REQUIRED",
      REQUEST_APPROVAL_REQUIRED_MESSAGE,
    );
  }
}

/** A subscription approved without a successful payment: a plan is paid at purchase. */
export function subscriptionUnpaidError(): BookingRuleError {
  return new BookingRuleError(
    "SUBSCRIPTION_UNPAID",
    "This plan is paid at purchase — the request has no successful payment.",
  );
}

/** Another buyer holds this 1:1 window; codeless so the classifier still answers it by message. */
export class SlotTakenError extends Error {
  constructor() {
    super("Time slot is already booked");
    this.name = "SlotTakenError";
  }
}
