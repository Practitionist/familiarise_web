/**
 * The host's single-session options: published + unbooked is Free, unpublished
 * is Outside your hours (still allowed for an event), any booked atom is Busy,
 * and the lead and the allowed window make a start unpickable.
 */

import {
  atomIndex,
  singleSessionOptions,
} from "@/lib/scheduling/single-session-options";

const HOUR = 3_600_000;
const DAY_START = Date.parse("2026-11-20T00:00:00.000Z");

function cell(startH: number, endH: number, bookingStatus = "available") {
  return {
    startsAt: new Date(DAY_START + startH * HOUR).toISOString(),
    endsAt: new Date(DAY_START + endH * HOUR).toISOString(),
    bookingStatus,
  };
}

// Published 09:00–12:00 UTC; 10:00–10:30 is booked.
const data = {
  "2026-11-20": [cell(9, 10), cell(10, 10.5, "fully-booked"), cell(10.5, 12)],
} as never;

describe("singleSessionOptions", () => {
  const atoms = atomIndex(data);
  const options = singleSessionOptions({
    atoms,
    dayStartMs: DAY_START,
    dayEndMs: DAY_START + 24 * HOUR,
    sessionMinutes: 60,
    notBeforeMs: DAY_START + 8 * HOUR,
    allowedEndMs: DAY_START + 23 * HOUR,
  });
  const at = (h: number) =>
    options.find((o) => o.startMs === DAY_START + h * HOUR);

  it("offers every half-hour start of the day", () => {
    expect(options).toHaveLength(48);
  });

  it("labels each start", () => {
    expect(at(7)?.state).toBe("tooSoon");
    expect(at(8)?.state).toBe("outsideHours");
    expect(at(9)?.state).toBe("free"); // 09:00–10:00 ends where the booking starts
    expect(at(9.5)?.state).toBe("busy");
    expect(at(10.5)?.state).toBe("free");
    expect(at(11)?.state).toBe("free");
    expect(at(11.5)?.state).toBe("outsideHours"); // runs past 12:00
    expect(at(22.5)?.state).toBe("outsideWindow"); // ends after 23:00
  });

  it("lets a host pick free and outside-hours starts only", () => {
    expect(at(8)?.selectable).toBe(true);
    expect(at(11)?.selectable).toBe(true);
    expect(at(9.5)?.selectable).toBe(false);
    expect(at(7)?.selectable).toBe(false);
  });
});
