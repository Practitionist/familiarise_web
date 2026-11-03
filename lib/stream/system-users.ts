/**
 * Author of the retired server-posted booking cards. Nothing posts as it any more;
 * its old messages are hidden in chat and it never counts as a DM member.
 */
export const LEGACY_BOOKING_CONTEXT_USER_ID = "system-booking-context";

/** Drops the retired cards; returns the same array when there are none. */
export function withoutLegacyBookingCards<
  T extends { user?: { id?: string } | null },
>(messages: T[]): T[] {
  const kept = messages.filter(
    (m) => m.user?.id !== LEGACY_BOOKING_CONTEXT_USER_ID,
  );
  return kept.length === messages.length ? messages : kept;
}
