/**
 * The Stream user that posts booking-context cards. It has no Postgres row and
 * no token is ever minted for it, so only the server can author its messages.
 * The `system-` prefix keeps `stream-sync` from deleting it. Safe to import from client components.
 */
export const BOOKING_CONTEXT_STREAM_USER = {
  id: "system-booking-context",
  name: "Familiarise",
} as const;

export function isBookingContextAuthor(userId: string | null | undefined) {
  return userId === BOOKING_CONTEXT_STREAM_USER.id;
}
