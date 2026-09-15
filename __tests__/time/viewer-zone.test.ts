/**
 * The viewer-zone rail: a rendered time is a function of (instant, zone,
 * pattern) alone, and the zone resolves user → fallback → UTC. Pinned because
 * the runtime zone is what produced hydration error #418 on the Appointments
 * pages (server in UTC, browser in Asia/Kolkata).
 */

import {
  describeViewerZone,
  formatForViewer,
  formatInViewerZone,
  resolveViewerZone,
} from "../../lib/time/viewer-zone";

const instant = new Date("2026-09-15T09:00:00Z");

describe("formatInViewerZone", () => {
  it("formats the same instant per zone, independent of the runtime zone", () => {
    expect(formatInViewerZone(instant, "Asia/Kolkata", "h:mm a")).toBe(
      "2:30 PM",
    );
    expect(formatInViewerZone(instant, "UTC", "h:mm a")).toBe("9:00 AM");
    expect(
      formatInViewerZone(
        "2026-09-15T09:00:00Z",
        "Asia/Kolkata",
        "EEE, d MMM · h:mm a",
      ),
    ).toBe("Tue, 15 Sep · 2:30 PM");
  });

  it("labels a time only when the zone is not the viewer's own", () => {
    expect(
      formatForViewer(instant, { zone: "Asia/Kolkata", own: true }, "h:mm a"),
    ).toBe("2:30 PM");
    expect(
      formatForViewer(instant, { zone: "UTC", own: false }, "h:mm a"),
    ).toBe("9:00 AM UTC");
  });
});

describe("resolveViewerZone", () => {
  it("prefers the user's zone, then the fallback, then UTC", () => {
    expect(
      resolveViewerZone({
        userTimezone: "Asia/Kolkata",
        fallbackZone: "Europe/London",
      }),
    ).toBe("Asia/Kolkata");
    expect(resolveViewerZone({ fallbackZone: "Europe/London" })).toBe(
      "Europe/London",
    );
    expect(resolveViewerZone({})).toBe("UTC");
    // A corrupt saved value is skipped rather than crashing the page.
    expect(resolveViewerZone({ userTimezone: "Not/AZone" })).toBe("UTC");
  });

  it("marks the zone as the viewer's own only when it came from the user", () => {
    expect(describeViewerZone({ userTimezone: "Asia/Kolkata" })).toEqual({
      zone: "Asia/Kolkata",
      own: true,
    });
    expect(describeViewerZone({ fallbackZone: "Asia/Kolkata" })).toEqual({
      zone: "Asia/Kolkata",
      own: false,
    });
  });
});
