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
  | "EXIT_NOT_AVAILABLE"
  | "BACKUP_INTEREST_CAP"
  | "BACKUP_WINDOW_PAST"
  | "ENROLMENT_CLOSED"
  | "CLASS_PRICE_CHANGED";

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
