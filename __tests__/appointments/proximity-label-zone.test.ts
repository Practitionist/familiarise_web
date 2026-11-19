/**
 * @jest-environment node
 */

/**
 * "Today" and "Tomorrow" are counted in the viewer's zone, not the runtime's:
 * a 05:30 IST session read at 03:30 IST is today in India and tomorrow in UTC.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CountdownBadge } from "@/components/appointments/CountdownBadge";
import { getProximityLabel } from "@/lib/appointments/occurrences";
import { DisplayZoneProvider } from "@/lib/time/zoned-format";

// 05:30 IST on 18 Nov 2026 is 00:00 UTC; "now" is 22:00 UTC on 17 Nov (03:30 IST on 18 Nov).
const SESSION = new Date("2026-11-18T00:00:00.000Z");
const NOW = new Date("2026-11-17T22:00:00.000Z");

describe("getProximityLabel", () => {
  it("counts days in the viewer's zone", () => {
    expect(getProximityLabel(SESSION, "Asia/Kolkata", NOW)).toBe("Today");
    expect(getProximityLabel(SESSION, "UTC", NOW)).toBe("Tomorrow");
  });

  it("keeps minutes and weeks", () => {
    const soon = new Date(NOW.getTime() + 45 * 60_000);
    expect(getProximityLabel(soon, "Asia/Kolkata", NOW)).toBe("in 45 min");
    // 13 calendar days still reads in days; whole weeks start at 14, rounded down.
    const later = new Date("2026-12-01T00:00:00.000Z");
    expect(getProximityLabel(later, "Asia/Kolkata", NOW)).toBe("in 13 days");
    const fortnight = new Date("2026-12-02T00:00:00.000Z");
    expect(getProximityLabel(fortnight, "Asia/Kolkata", NOW)).toBe(
      "in 2 weeks",
    );
    expect(getProximityLabel(null, "UTC", NOW)).toBeNull();
  });
});

describe("the list row and the Next card's chip", () => {
  // Thu 19 Nov 19:00 IST to Fri 27 Nov 11:00 IST: 8 calendar days, 7 d 16 h elapsed.
  const now = new Date("2026-11-19T13:30:00.000Z");
  const session = new Date("2026-11-27T05:30:00.000Z");

  afterEach(() => jest.restoreAllMocks());

  it("count the same days for one session", () => {
    jest.spyOn(Date, "now").mockReturnValue(now.getTime());
    const chip = renderToStaticMarkup(
      createElement(
        DisplayZoneProvider,
        { zone: "Asia/Kolkata" },
        createElement(CountdownBadge, { targetDate: session }),
      ),
    );
    expect(getProximityLabel(session, "Asia/Kolkata", now)).toBe("in 8 days");
    expect(chip).toContain(">8d<");
  });
});
