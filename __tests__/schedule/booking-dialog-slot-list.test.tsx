/**
 * @jest-environment node
 */

/**
 * The booking dialog uses the same semantic colors as its date marks. Taken
 * and past times are omitted, while book-now and request paths remain labeled.
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
  it("renders labeled instant and request rows in their semantic colors", () => {
    const html = renderToStaticMarkup(
      <SlotList
        slots={THREE}
        selectedSlot={null}
        onSelect={() => undefined}
        bookingMode="INSTANT"
        acceptingRequests={true}
      />,
    );
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html.match(/>Request</g)).toHaveLength(1);
    expect(html.match(/>Book now</g)).toHaveLength(1);
    expect(html).toContain("1 time on this day is already taken");
    expect(html).toMatch(/emerald/);
    expect(html).toMatch(/amber/);
    expect(html).not.toMatch(/rose/);
  });

  it("disables request times when the expert has paused requests", () => {
    const html = renderToStaticMarkup(
      <SlotList
        slots={THREE}
        selectedSlot={null}
        onSelect={() => undefined}
        bookingMode="REQUEST"
        acceptingRequests={false}
      />,
    );
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html.match(/Requests paused/g)).toHaveLength(2);
    expect(html).not.toMatch(/bg-amber/);
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
