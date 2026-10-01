import {
  isCurrentBookingWindow,
  sameBookingWindow,
} from "@/lib/booking/selection";

const window = {
  startsAt: "2026-10-05T10:00:00Z",
  endsAt: "2026-10-05T11:00:00Z",
};

describe("booking review selection", () => {
  it("matches equivalent instants across serialized timezone offsets", () => {
    expect(
      sameBookingWindow(window, {
        startsAt: "2026-10-05T15:30:00+05:30",
        endsAt: "2026-10-05T16:30:00+05:30",
      }),
    ).toBe(true);
    expect(
      sameBookingWindow(window, { ...window, endsAt: "2026-10-05T12:00:00Z" }),
    ).toBe(false);
  });
  it("rejects booked, expired, malformed, and reversed windows", () => {
    const now = Date.parse("2026-10-05T09:00:00Z");
    expect(isCurrentBookingWindow(window, now, 60 * 60 * 1000)).toBe(true);
    expect(isCurrentBookingWindow(window, now + 1, 60 * 60 * 1000)).toBe(false);
    expect(
      isCurrentBookingWindow(
        { ...window, bookingStatus: "fully-booked" },
        now,
        0,
      ),
    ).toBe(false);
    expect(isCurrentBookingWindow({ ...window, _isPast: true }, now, 0)).toBe(
      false,
    );
    expect(
      isCurrentBookingWindow({ ...window, endsAt: "invalid" }, now, 0),
    ).toBe(false);
    expect(
      isCurrentBookingWindow({ ...window, endsAt: window.startsAt }, now, 0),
    ).toBe(false);
  });
});
