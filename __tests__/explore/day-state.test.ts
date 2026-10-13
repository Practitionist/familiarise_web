/**
 * @jest-environment node
 */
/**
 * #1643 — Duration-aware dayState for multi-slot consultations and
 * consulteeUserId scoping in availabilityQueryKey.
 */
import {
  dayState,
  type DayMarkSlot,
} from "@/app/explore/experts/[consultantId]/day-state";
import { availabilityQueryKey } from "@/app/explore/experts/[consultantId]/hooks/useAvailabilityWindow";

const NOW = new Date("2026-10-14T10:00:00.000Z");
const TARGET_DAY = new Date("2026-10-20T00:00:00.000Z");

function slotRange(
  startHourUtc: number,
  startMinUtc: number,
  endHourUtc: number,
  endMinUtc: number,
  bookingStatus: DayMarkSlot["bookingStatus"] = "available",
): DayMarkSlot {
  const start = new Date(Date.UTC(2026, 9, 20, startHourUtc, startMinUtc, 0));
  const end = new Date(Date.UTC(2026, 9, 20, endHourUtc, endMinUtc, 0));
  return {
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    bookingStatus,
  };
}

describe("dayState duration awareness (#1643)", () => {
  it("marks fragmented 30-min slots as bookable for 0.5h but none for 1.0h", () => {
    // Two isolated 30-minute slots separated by a gap (09:00-09:30 and 11:00-11:30)
    const fragmentedSlots: DayMarkSlot[] = [
      slotRange(9, 0, 9, 30, "available"),
      slotRange(11, 0, 11, 30, "available"),
    ];

    expect(dayState(TARGET_DAY, NOW, fragmentedSlots, "UTC", 0.5)).toBe(
      "bookable",
    );
    expect(dayState(TARGET_DAY, NOW, fragmentedSlots, "UTC", 1.0)).toBe("none");
  });

  it("marks contiguous 30-min slots as bookable for 1.0h and none for 1.5h", () => {
    // Two back-to-back 30-minute slots forming a contiguous 1-hour block (09:00-10:00)
    const oneHourBlock: DayMarkSlot[] = [
      slotRange(9, 0, 9, 30, "available"),
      slotRange(9, 30, 10, 0, "available"),
    ];

    expect(dayState(TARGET_DAY, NOW, oneHourBlock, "UTC", 1.0)).toBe(
      "bookable",
    );
    expect(dayState(TARGET_DAY, NOW, oneHourBlock, "UTC", 1.5)).toBe("none");
  });

  it("supports passing a day-keyed map of slots with durationInHours", () => {
    const slotsByDay: Record<string, DayMarkSlot[]> = {
      "2026-10-20": [slotRange(9, 0, 9, 30, "available")],
    };

    expect(dayState(TARGET_DAY, slotsByDay, NOW, "UTC", 0.5)).toBe("bookable");
    expect(dayState(TARGET_DAY, slotsByDay, NOW, "UTC", 1.0)).toBe("none");
  });
});

describe("availabilityQueryKey consulteeUserId scoping (#1643)", () => {
  it("omits consulteeUserId when not provided and appends it when provided", () => {
    const start = new Date("2026-10-20T00:00:00.000Z");
    const end = new Date("2026-10-26T23:59:59.999Z");

    expect(availabilityQueryKey("consultant-1", start, end, "UTC")).toEqual([
      "availability",
      "consultant-1",
      start.toISOString(),
      end.toISOString(),
      "UTC",
    ]);

    expect(
      availabilityQueryKey("consultant-1", start, end, "UTC", "user-42"),
    ).toEqual([
      "availability",
      "consultant-1",
      start.toISOString(),
      end.toISOString(),
      "UTC",
      "user-42",
    ]);
  });
});
