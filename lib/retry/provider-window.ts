const PROVIDER_WINDOW_MS = 24 * 60 * 60 * 1000;

export const PROVIDER_WINDOW_EXPIRED = "review:provider_acceptance_unknown";
export const PROVIDER_TIMESTAMP_INVALID = "review:invalid_delivery_timestamp";

/** Staging/due time is a conservative lower bound on a provider's first possible acceptance. */
export function providerWindowRefusal(
  createdAt: Date | string | undefined,
  now: Date,
  notBefore?: Date | null,
): typeof PROVIDER_WINDOW_EXPIRED | typeof PROVIDER_TIMESTAMP_INVALID | null {
  const created =
    createdAt === undefined ? Number.NaN : new Date(createdAt).getTime();
  const floor = notBefore ? notBefore.getTime() : created;
  if (!Number.isFinite(created) || !Number.isFinite(floor))
    return PROVIDER_TIMESTAMP_INVALID;
  return now.getTime() - Math.max(created, floor) >= PROVIDER_WINDOW_MS
    ? PROVIDER_WINDOW_EXPIRED
    : null;
}
