import type { QueryClient } from "@tanstack/react-query";

import {
  RefundQuoteChangedSchema,
  type CancelRefundPreview,
  type RefundQuoteChanged,
} from "@/schemas/appointments";

/** The quote a cancel click carries back, so the server charges what was shown. */
export type ShownCancelQuote = {
  estimatedRefundPaise: number;
  creditRestoresInFull?: boolean;
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
  };
}

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
          }
        : prior,
  );
}
