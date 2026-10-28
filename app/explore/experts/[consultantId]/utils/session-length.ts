/**
 * Session length as a buyer reads it on a storefront: "30 mins", "60 mins",
 * "90 mins", "2 hours". The catalog stores `durationInHours` as a Float, so
 * every surface that interpolates it directly ("Available 0.5 hour Slots")
 * leaks a machine value into buyer-facing copy. Route them through here.
 *
 * Minutes are the unit below two hours and hours above it, because "1 hour"
 * reads worse than "60 mins" next to a 15- and a 90-minute option, while
 * "150 mins" reads worse than "2.5 hours" only rarely enough to matter.
 */
export function formatSessionLength(durationInHours: number): string {
  if (!Number.isFinite(durationInHours) || durationInHours <= 0) return "";

  const minutes = Math.round(durationInHours * 60);

  if (minutes < 120) return `${minutes} mins`;
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} mins`;
}

/**
 * The same length as a modifier: "a 60-min session", "a 2-hour session".
 * A length under an hour reads better as "30-min" than as "0.5-hour".
 */
export function formatSessionLengthModifier(durationInHours: number): string {
  if (!Number.isFinite(durationInHours) || durationInHours <= 0) return "";

  const minutes = Math.round(durationInHours * 60);

  if (minutes < 60) return `${minutes}-min`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-min`;
}
