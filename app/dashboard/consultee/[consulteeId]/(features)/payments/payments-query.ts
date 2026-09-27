/**
 * #1527 — the Payments page's URL filter keys and react-query key, in a
 * directive-free module so the RSC page can seed the exact key the client
 * component reads (a "use client" export is only a reference on the server).
 */

export const PAYMENT_FILTER_KEYS = ["status", "range"] as const;
export type PaymentFilterKey = (typeof PAYMENT_FILTER_KEYS)[number];

/** Raw URL strings go in, not parsed ones: both sides read the same URL. */
export function consulteePaymentsKey(
  consulteeId: string,
  page: number,
  status: string | null,
  range: string | null,
) {
  return [
    "consultee-payments",
    consulteeId,
    "personal",
    page,
    status,
    range,
  ] as const;
}
