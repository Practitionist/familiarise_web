import type { ProcessedSlot } from "../types";

/**
 * Merge consecutive slots with the same booking status for display purposes.
 * E.g., "3:30-4:00" + "4:00-4:30" + "4:30-5:00" (all available) → "3:30-5:00 PM"
 *
 * Unlike `mergeConsecutiveSlots()` in utils/timeSlotsProcessing.ts (which only merges
 * available slots for booking logic), this merges any consecutive same-status slots.
 */
export function mergeConsecutiveSlotsForDisplay(
  slots: ProcessedSlot[],
): ProcessedSlot[] {
  if (!slots || slots.length === 0) return [];

  const sorted = [...slots].sort((a, b) => {
    const aStart = a.slotStartTimeInUTC
      ? new Date(a.slotStartTimeInUTC).getTime()
      : 0;
    const bStart = b.slotStartTimeInUTC
      ? new Date(b.slotStartTimeInUTC).getTime()
      : 0;
    return aStart - bStart;
  });

  const merged: ProcessedSlot[] = [];
  let current = { ...sorted[0] };

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];

    const currentEnd = current.slotEndTimeInUTC
      ? new Date(current.slotEndTimeInUTC).getTime()
      : 0;
    const nextStart = next.slotStartTimeInUTC
      ? new Date(next.slotStartTimeInUTC).getTime()
      : 0;

    const isConsecutive = Math.abs(currentEnd - nextStart) <= 60000; // 1-min tolerance
    const sameStatus = getEffectiveStatus(current) === getEffectiveStatus(next);

    if (isConsecutive && sameStatus) {
      // Extend the current merged slot
      current = {
        ...current,
        slotEndTimeInUTC: next.slotEndTimeInUTC,
        localEndTime: next.localEndTime,
      };
    } else {
      merged.push(current);
      current = { ...next };
    }
  }

  merged.push(current);
  return merged;
}

/** Derive a single status key that accounts for isAllocated + bookingStatus */
function getEffectiveStatus(slot: ProcessedSlot): string {
  if (slot.bookingStatus === "fully-booked") return "fully-booked";
  if (slot.bookingStatus === "partially-booked") return "partially-booked";
  if (slot.isAllocated) return "allocated";
  return "available";
}
