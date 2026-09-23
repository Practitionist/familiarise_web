import type { BookingMode } from "@prisma/client";
import type { TIntervalTiming } from "@/types/slots";

/** A duration window of the day's grid, with the allocation overlay and the client-side past flag. */
export type SlotWithStatus = TIntervalTiming & {
  isAllocated: boolean;
  bookingStatus: "available" | "partially-booked" | "fully-booked";
  _isPast: boolean;
};

/**
 * What the slot list shows (#1785 L-3). Calendly lists only the times you
 * can take: a taken or past slot is not a disabled red row, it is absent, and
 * one muted line says how many were dropped so a sparse day does not read as
 * a sparse expert.
 */
export function partitionSlotsForList<T extends SlotWithStatus>(
  slots: readonly T[],
): { bookable: T[]; takenCount: number } {
  const bookable = slots.filter(
    (slot) => !slot._isPast && slot.bookingStatus !== "fully-booked",
  );
  return { bookable, takenCount: slots.length - bookable.length };
}

/** "N times on this day are already taken", or null when nothing was dropped. */
export function takenTimesLine(takenCount: number): string | null {
  if (takenCount <= 0) return null;
  return takenCount === 1
    ? "1 time on this day is already taken"
    : `${takenCount} times on this day are already taken`;
}

/**
 * A slot the expert has to confirm before payment carries a small "Request"
 * tag: every slot under REQUEST mode, and a contended one under INSTANT — the
 * same predicate `consultationCtaFor` applies to the button (#1703 D1), so
 * the tag and the button never disagree. `partially-booked` is not a separate
 * arm: the grid derives it from the same overlapping appointments that set
 * `isAllocated`, so it never occurs without it.
 */
export function slotNeedsRequest(
  mode: BookingMode,
  slot: Pick<SlotWithStatus, "isAllocated">,
): boolean {
  return mode === "REQUEST" || slot.isAllocated;
}
