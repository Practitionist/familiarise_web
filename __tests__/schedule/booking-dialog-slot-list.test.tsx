/**
 * @jest-environment node
 */

/**
 * #1785 L-3 — the booking dialog's slot list is monochrome: taken and past
 * times are not rendered (one muted line counts them), a time the expert must
 * confirm carries a "Request" tag, and no traffic-light class reaches the DOM.
 */
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SlotList } from "@/app/explore/experts/[consultantId]/components/SlotList";
import {
  partitionSlotsForList,
  takenTimesLine,
  type SlotWithStatus,
} from "@/app/explore/experts/[consultantId]/components/slot-list-policy";

function slot(
  id: string,
  overrides: Partial<SlotWithStatus> = {},
): SlotWithStatus {
  return {
    slotId: id,
    dateInISO: "2026-10-05",
    dayOfWeek: "MONDAY",
    startsAt: "2026-10-05T04:30:00.000Z",
    endsAt: "2026-10-05T05:30:00.000Z",
    availabilityWindowId: "aw-1",
    appointmentOccurrenceId: "",
    localStartTime: "10:00 AM",
    localEndTime: "11:00 AM",
    type: "WEEKLY",
    isAllocated: false,
    bookingStatus: "available",
    _isPast: false,
    ...overrides,
  };
}

const THREE = [
  slot("free"),
  slot("contended", { isAllocated: true, localStartTime: "11:00 AM" }),
  slot("taken", { bookingStatus: "fully-booked", localStartTime: "12:00 PM" }),
];

describe("SlotList (#1785 L-3)", () => {
  it("renders two rows, one Request tag, one already-taken line and no colour class", () => {
    const html = renderToStaticMarkup(
      <SlotList
        slots={THREE}
        selectedSlot={null}
        onSelect={() => undefined}
        bookingMode="INSTANT"
      />,
    );
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html.match(/>Request</g)).toHaveLength(1);
    expect(html).toContain("1 time on this day is already taken");
    expect(html).not.toMatch(/emerald|amber|rose/);
  });

  it("drops past and fully-booked slots and counts them", () => {
    const { bookable, takenCount } = partitionSlotsForList([
      ...THREE,
      slot("gone", { _isPast: true }),
    ]);
    expect(bookable.map((s) => s.slotId)).toEqual(["free", "contended"]);
    expect(takenCount).toBe(2);
    expect(takenTimesLine(2)).toBe("2 times on this day are already taken");
    expect(takenTimesLine(0)).toBeNull();
  });
});
