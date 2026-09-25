/**
 * Where a "Pay" button sends the buyer (#1775 P-1).
 *
 * For Razorpay the stored `checkoutUrl` / `pendingPaymentUrl` is the ORDER ID,
 * not a URL, so every surface that guarded on `^https?://` hid the only way to
 * pay an approval. Anything that is not an http(s) URL now resolves to our own
 * pay page, which opens the existing order in the Razorpay sheet. Pure and
 * Prisma-free so client components may import it.
 */

const PAY_PAGE_PREFIX = "/checkout/pay/";
const EXTERNAL_URL = /^https?:\/\//;

export function payPagePath(paymentId: string): string {
  return `${PAY_PAGE_PREFIX}${encodeURIComponent(paymentId)}`;
}

export function payLinkHref(args: {
  paymentId: string | null | undefined;
  checkoutUrl: string | null | undefined;
}): string | null {
  const { paymentId, checkoutUrl } = args;
  if (checkoutUrl && EXTERNAL_URL.test(checkoutUrl)) return checkoutUrl;
  // A trial persists the page path itself (persistTrialPayLink).
  if (checkoutUrl?.startsWith(PAY_PAGE_PREFIX)) return checkoutUrl;
  return paymentId ? payPagePath(paymentId) : null;
}

/** True when the href leaves the app (a hosted gateway link). */
export function isExternalPayHref(href: string): boolean {
  return EXTERNAL_URL.test(href);
}

/**
 * The payable Payment among a booking's rows: the newest PENDING one, else an
 * EXPIRED one the pay page can re-mint into. SUCCEEDED/FAILED are not payable.
 */
export function payablePaymentId(
  payments:
    | ReadonlyArray<{
        id: string;
        paymentStatus: string;
        createdAt?: Date | string;
      }>
    | null
    | undefined,
): string | null {
  if (!payments?.length) return null;
  const byNewest = [...payments].sort(
    (a, b) =>
      new Date(b.createdAt ?? 0).getTime() -
      new Date(a.createdAt ?? 0).getTime(),
  );
  return (
    byNewest.find((p) => p.paymentStatus === "PENDING")?.id ??
    byNewest.find((p) => p.paymentStatus === "EXPIRED")?.id ??
    null
  );
}
