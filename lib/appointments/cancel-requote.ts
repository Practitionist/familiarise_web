import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";

import {
  RefundQuoteChangedSchema,
  type CancelRefundPreview,
  type RefundQuoteChanged,
} from "@/schemas/appointments";

/** The quote a cancel click carries back, so the server charges what was shown. */
export type ShownCancelQuote = {
  estimatedRefundPaise: number;
  creditRestoresInFull?: boolean;
  /** False when the dialog showed an unpaid booking. */
  expectedPaid?: boolean;
  /** The dialog showed a free booking; read by the confirmation toast, never sent. */
  freeBooking?: boolean;
};

/** The binding for a dialog that showed an unpaid booking (an approval awaiting payment). */
export const UNPAID_CANCEL_QUOTE: ShownCancelQuote = {
  estimatedRefundPaise: 0,
  expectedPaid: false,
};

export const cancelPreviewUrl = (appointmentId: string) =>
  `/api/appointments/${appointmentId}/cancel/preview`;

/** The cache key every cancel dialog reads its quote under. */
export const cancelPreviewQueryKey = (url: string) =>
  ["cancel-refund-preview", url] as const;

/** The cancel POST body fields that bind the click to the quote it showed. */
export function shownQuoteBody(quote: ShownCancelQuote | undefined) {
  if (!quote) return {};
  return {
    expectedRefundPaise: quote.estimatedRefundPaise,
    ...(quote.creditRestoresInFull === undefined
      ? {}
      : { expectedCreditRestoresInFull: quote.creditRestoresInFull }),
    ...(quote.expectedPaid === undefined
      ? {}
      : { expectedPaid: quote.expectedPaid }),
  };
}

/** A re-quote of a click made on an unpaid screen: the payment landed, so the dialog must reopen on the paid quote. */
export const paymentLandedUnderClick = (quote: ShownCancelQuote | undefined) =>
  quote?.expectedPaid === false;

/** The server's new figure from a 409 `REFUND_QUOTE_CHANGED` body, or null for any other answer. */
export function readRefundQuoteChanged(
  body: unknown,
): RefundQuoteChanged | null {
  const parsed = RefundQuoteChangedSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

/** Re-renders an open dialog's quote with the server's new figure, so the next click confirms it. */
export function applyRefundRequote(
  queryClient: QueryClient,
  previewUrl: string,
  requote: RefundQuoteChanged,
): void {
  queryClient.setQueryData<CancelRefundPreview>(
    cancelPreviewQueryKey(previewUrl),
    (prior) =>
      prior && prior.paid !== false
        ? {
            ...prior,
            estimatedRefundPaise: requote.refundPaise,
            refundPct: requote.refundPct,
            creditRestoresInFull: requote.creditRestoresInFull,
            // The server only re-quotes a paid booking.
            ...(prior.expectedPaid === undefined ? {} : { expectedPaid: true }),
          }
        : prior,
  );
}

/**
 * A cancel door refusing with nothing committed: the session is about to
 * start, under way or held, or another refund on the booking must finish first.
 */
const CancelRefusalSchema = z.object({
  code: z.enum([
    "SESSION_IN_PROGRESS",
    "SESSION_ALREADY_DELIVERED",
    "REFUND_IN_PROGRESS",
    "REFUND_NEEDS_SUPPORT",
  ]),
  error: z.string(),
});

/** The dialog shows this refusal's sentence and offers no confirm. */
export class CancelRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CancelRefusedError";
  }
}

/** 409 codes meaning the booking already moved on; any other 409 is a refusal to show. */
const ALREADY_SETTLED_CODES: ReadonlySet<string> = new Set([
  "NOT_CANCELLABLE",
  "BOOKING_CHANGED",
  "ILLEGAL_TRANSITION",
]);

/** Whether a 409 cancel answer means "already cancelled or changed — refresh". */
export function cancelAlreadySettled(code: string | undefined): boolean {
  return code === undefined || ALREADY_SETTLED_CODES.has(code);
}

/** The refusal in a preview or cancel answer, or null for any other body. */
export function cancelRefusalFrom(body: unknown): CancelRefusedError | null {
  const parsed = CancelRefusalSchema.safeParse(body);
  return parsed.success ? new CancelRefusedError(parsed.data.error) : null;
}
