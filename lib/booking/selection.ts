/** Compare instants, not serialized offsets; availability can use either. */
export function sameBookingWindow(
  a: { startsAt: string; endsAt: string },
  b: { startsAt: string; endsAt: string },
): boolean {
  return (
    Date.parse(a.startsAt) === Date.parse(b.startsAt) &&
    Date.parse(a.endsAt) === Date.parse(b.endsAt)
  );
}

export function isCurrentBookingWindow(
  slot: {
    startsAt: string;
    endsAt: string;
    bookingStatus?: string;
    _isPast?: boolean;
  },
  now: number,
  leadTime: number,
): boolean {
  const start = Date.parse(slot.startsAt);
  const end = Date.parse(slot.endsAt);
  return (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end > start &&
    start >= now + leadTime &&
    !slot._isPast &&
    slot.bookingStatus !== "fully-booked"
  );
}
