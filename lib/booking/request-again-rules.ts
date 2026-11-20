/**
 * "Request again" on a booking whose pay window closed while its order is still
 * PENDING: the old order is closed first, then the new request starts. The pure
 * half, shared by every surface that offers the action and by the route.
 * Prisma-free so client components can import it.
 */
import { z } from "zod";

/** The history reason on every edge the click writes; the Home lapsed-link list skips it. */
export const REQUESTED_AGAIN_REASON = "REQUESTED_AGAIN";

/** The engagement-reversal note the closed order leaves on an organisation's usage row. */
export const REQUEST_AGAIN_NOTE =
  "Closed by the learner before requesting again";

/** The confirmation shown before the old order is closed. */
export const REQUEST_AGAIN_WARNING =
  "Your earlier payment link will be closed, and a payment that reaches it after this is refunded automatically. If it was already paid, that booking is kept and no new request starts.";

/** The answer to a click that lost to a capture: nothing was closed. */
export const REQUEST_AGAIN_ALREADY_PAID =
  "Your earlier payment went through, so that booking is confirmed. No new request was started.";

/** A payment row as every booking surface already reads it. */
export interface RequestAgainPaymentRow {
  paymentStatus: string;
  expiresAt: Date | string | null;
}

/** True when an order is still PENDING after its window closed, so a late capture could still land. */
export function openOrderPastWindow(
  payments: readonly RequestAgainPaymentRow[],
  now: Date,
): boolean {
  return payments.some(
    (p) =>
      p.paymentStatus === "PENDING" &&
      p.expiresAt !== null &&
      new Date(p.expiresAt).getTime() <= now.getTime(),
  );
}

export const requestAgainPath = (appointmentId: string) =>
  `/api/bookings/${encodeURIComponent(appointmentId)}/request-again`;

export const RequestAgainParamsSchema = z.object({
  bookingId: z.string().uuid(),
});

export const REQUEST_AGAIN_REFUSALS = [
  "NOT_FOUND",
  "ALREADY_PAID",
  "PAYMENT_IN_PROGRESS",
  "GATEWAY_UNCHECKED",
  "PAY_WINDOW_OPEN",
  "NOT_CLOSABLE",
] as const;
export type RequestAgainRefusal = (typeof REQUEST_AGAIN_REFUSALS)[number];

/** The booking lock's answers (423, 503): try again shortly, not a refusal. */
export const REQUEST_AGAIN_LOCK_CODES = [
  "APPOINTMENT_BUSY",
  "BOOKING_LOCK_UNAVAILABLE",
] as const;

/** What the route answers; the control parses it before it navigates. */
export const RequestAgainAnswerSchema = z.union([
  z.object({ closed: z.number().int().nonnegative() }),
  z.object({ code: z.enum(REQUEST_AGAIN_REFUSALS), error: z.string() }),
  z.object({ code: z.enum(REQUEST_AGAIN_LOCK_CODES), error: z.string() }),
]);
export type RequestAgainAnswer = z.infer<typeof RequestAgainAnswerSchema>;
