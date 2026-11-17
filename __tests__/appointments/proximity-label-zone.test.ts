/**
 * @jest-environment node
 */

/**
 * "Today" and "Tomorrow" are counted in the viewer's zone, not the runtime's:
 * a 05:30 IST session read at 03:30 IST is today in India and tomorrow in UTC.
 */
import { getProximityLabel } from "@/lib/appointments/occurrences";

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
    const later = new Date("2026-12-01T00:00:00.000Z");
    expect(getProximityLabel(later, "Asia/Kolkata", NOW)).toBe("in 2 weeks");
    expect(getProximityLabel(null, "UTC", NOW)).toBeNull();
  });
});
